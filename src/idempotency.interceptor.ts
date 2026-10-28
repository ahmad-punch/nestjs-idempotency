import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { catchError, defer, from, mergeAll, mergeMap, type Observable, of, throwError } from 'rxjs';
import { IDEMPOTENCY_OPTIONS, IDEMPOTENT_METADATA, REPLAYED_HEADER } from './idempotency.constants';
import {
  type IdempotencyException,
  invalidKeyError,
  keyReuseError,
  missingKeyError,
  requestInProgressError,
} from './idempotency.errors';
import { readIdempotencyKey } from './idempotency-key';
import { type ResolvedIdempotencyOptions } from './idempotency.options';
import { type IdempotentRequest } from './idempotency.types';
import { type IdempotentOptions } from './idempotent.decorator';
import { storageKeyFor } from './scope';
import {
  type IdempotencyLease,
  type IdempotencyRecord,
  type StoredResponse,
} from './stores/idempotency-store.interface';

/** Marks a request so the interceptor runs once even if bound twice (global and per route). */
const HANDLED = Symbol('nestjs-idempotency:handled');

interface RawRequest {
  headers?: IncomingHttpHeaders;
  body?: unknown;
  user?: unknown;
  [HANDLED]?: boolean;
}

interface RawResponse {
  statusCode?: number;
  headersSent?: boolean;
  sent?: boolean;
}

interface RoutePolicy {
  ttlMs: number;
  requireKey: boolean;
}

/**
 * Implements idempotent request handling. Bound automatically by
 * `@Idempotent()`; register it globally to cover every POST and PATCH route.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Idempotency');

  constructor(
    @Inject(IDEMPOTENCY_OPTIONS) private readonly options: ResolvedIdempotencyOptions,
    private readonly reflector: Reflector,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<RawRequest>();
    const response = http.getResponse<RawResponse>();
    const routeOptions = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(IDEMPOTENT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const described = this.describe(request);
    if (request[HANDLED] || !this.applies(routeOptions, described.method)) {
      return next.handle();
    }
    request[HANDLED] = true;

    const policy = this.policyFor(routeOptions);
    const parsed = readIdempotencyKey(described.headers, this.options.keyHeader);
    switch (parsed.status) {
      case 'missing':
        return policy.requireKey ? this.reject(response, missingKeyError(this.options.keyHeader)) : next.handle();
      case 'invalid':
        return this.reject(response, invalidKeyError(parsed.reason));
      case 'valid':
        return defer(() => this.process(described, response, parsed.key, policy, next)).pipe(mergeAll());
    }
  }

  private async process(
    request: IdempotentRequest,
    response: RawResponse,
    key: string,
    policy: RoutePolicy,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const [scope, fingerprint] = await Promise.all([
      this.options.scope(request),
      this.options.fingerprint(request),
    ]);
    const outcome = await this.options.store.acquire(
      storageKeyFor(scope, key),
      fingerprint,
      this.options.lockTtlSeconds * 1000,
    );
    if (!outcome.acquired) {
      return this.answerFromRecord(outcome.record, fingerprint, response);
    }
    const { lease } = outcome;
    return next.handle().pipe(
      mergeMap((body) => from(this.saveResponse(lease, response, body, policy.ttlMs))),
      catchError((error: unknown) => from(this.releaseAndRethrow(lease, error))),
    );
  }

  private answerFromRecord(record: IdempotencyRecord, fingerprint: string, response: RawResponse): Observable<unknown> {
    if (record.fingerprint !== fingerprint) {
      return this.reject(response, keyReuseError(this.options.keyHeader));
    }
    if (record.status === 'in_progress') {
      this.setHeader(response, 'Retry-After', String(Math.ceil(this.options.retryAfterSeconds)));
      return this.reject(response, requestInProgressError(this.options.keyHeader, this.options.retryAfterSeconds));
    }
    for (const [name, value] of Object.entries(record.response.headers)) {
      this.setHeader(response, name, value);
    }
    this.setHeader(response, REPLAYED_HEADER, 'true');
    this.adapterHost.httpAdapter.status(response, record.response.statusCode);
    return of(record.response.body);
  }

  private async saveResponse(
    lease: IdempotencyLease,
    response: RawResponse,
    body: unknown,
    ttlMs: number,
  ): Promise<unknown> {
    const stored = this.capture(response, body);
    if (!stored) {
      await this.safely('release', () => this.options.store.release(lease));
      return body;
    }
    const saved = await this.safely('complete', () => this.options.store.complete(lease, stored, ttlMs));
    if (saved === false) {
      this.logger.warn(
        'The idempotency lock expired before the handler finished, so this response was not stored. ' +
          'Raise lockTtlSeconds above your slowest handler.',
      );
    }
    return body;
  }

  /** Errors are not stored: the key is freed so the client can retry with it. */
  private async releaseAndRethrow(lease: IdempotencyLease, error: unknown): Promise<never> {
    await this.safely('release', () => this.options.store.release(lease));
    throw error;
  }

  private capture(response: RawResponse, body: unknown): StoredResponse | undefined {
    if (response.headersSent || response.sent) {
      this.logger.warn(
        'The handler wrote the response itself (via @Res()), so it cannot be stored for replay. ' +
          'Return the body from the handler instead, or use @Res({ passthrough: true }).',
      );
      return undefined;
    }
    if (body instanceof StreamableFile || body instanceof Readable) {
      this.logger.warn('Streaming responses cannot be stored for replay; the idempotency key was released.');
      return undefined;
    }
    const serialized = toJsonValue(body);
    if (!serialized.ok) {
      this.logger.warn('The response body is not JSON-serialisable, so it cannot be stored for replay.');
      return undefined;
    }
    const stored: StoredResponse = {
      statusCode: response.statusCode ?? 200,
      headers: this.pickResponseHeaders(response),
    };
    if (serialized.value !== undefined) {
      stored.body = serialized.value;
    }
    return stored;
  }

  /** Store failures after the handler ran must not turn a success into an error. */
  private async safely<T>(operation: string, action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      this.logger.error(
        `Idempotency store "${operation}" failed; the response was sent but not recorded.`,
        error instanceof Error ? error.stack : String(error),
      );
      return undefined;
    }
  }

  private reject(response: RawResponse, exception: IdempotencyException): Observable<never> {
    this.setHeader(response, 'Content-Type', 'application/problem+json');
    return throwError(() => exception);
  }

  private applies(routeOptions: IdempotentOptions | undefined, method: string): boolean {
    return routeOptions !== undefined || this.options.methods.includes(method);
  }

  private policyFor(routeOptions: IdempotentOptions | undefined): RoutePolicy {
    return {
      ttlMs: (routeOptions?.ttlSeconds ?? this.options.ttlSeconds) * 1000,
      requireKey: routeOptions?.requireKey ?? this.options.requireKey,
    };
  }

  private describe(request: RawRequest): IdempotentRequest {
    const adapter = this.adapterHost.httpAdapter;
    const url = String(adapter.getRequestUrl(request) ?? '');
    return {
      method: String(adapter.getRequestMethod(request)).toUpperCase(),
      path: url.split('?', 1)[0] ?? '',
      headers: request.headers ?? {},
      body: request.body,
      user: request.user,
      raw: request,
    };
  }

  private pickResponseHeaders(response: RawResponse): Record<string, string> {
    const adapter = this.adapterHost.httpAdapter;
    const headers: Record<string, string> = {};
    for (const name of this.options.responseHeaders) {
      const value: unknown = adapter.getHeader(response, name);
      if (Array.isArray(value)) {
        headers[name] = value.map(String).join(', ');
      } else if (typeof value === 'string' || typeof value === 'number') {
        headers[name] = String(value);
      }
    }
    return headers;
  }

  private setHeader(response: RawResponse, name: string, value: string): void {
    this.adapterHost.httpAdapter.setHeader(response, name, value);
  }
}

function toJsonValue(body: unknown): { ok: true; value: unknown } | { ok: false } {
  if (body === undefined) {
    return { ok: true, value: undefined };
  }
  try {
    const json = JSON.stringify(body);
    return { ok: true, value: json === undefined ? undefined : (JSON.parse(json) as unknown) };
  } catch {
    return { ok: false };
  }
}
