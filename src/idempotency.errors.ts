import { HttpException, HttpStatus } from '@nestjs/common';

const PROBLEM_BASE = 'https://github.com/ahmad-punch/nestjs-idempotency#errors';

/** An RFC 9457 problem details body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/**
 * Raised by the interceptor before the handler runs. The body is a problem
 * details object; the interceptor also sets `Content-Type: application/problem+json`.
 */
export class IdempotencyException extends HttpException {
  constructor(problem: ProblemDetails) {
    super(problem, problem.status);
  }
}

export function missingKeyError(headerName: string): IdempotencyException {
  return new IdempotencyException({
    type: `${PROBLEM_BASE}-missing-key`,
    title: 'Idempotency key is missing',
    status: HttpStatus.BAD_REQUEST,
    detail: `This endpoint requires an ${headerName} header. Generate a unique value (a UUID v4 works) and send it with the request; reuse it when you retry.`,
  });
}

export function invalidKeyError(reason: string): IdempotencyException {
  return new IdempotencyException({
    type: `${PROBLEM_BASE}-invalid-key`,
    title: 'Idempotency key is invalid',
    status: HttpStatus.BAD_REQUEST,
    detail: reason,
  });
}

export function keyReuseError(headerName: string): IdempotencyException {
  return new IdempotencyException({
    type: `${PROBLEM_BASE}-key-reuse`,
    title: 'Idempotency key was already used for a different request',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    detail: `This ${headerName} was first sent with a different payload. Retry with the original payload, or use a new key for a new request.`,
  });
}

export function requestInProgressError(headerName: string, retryAfterSeconds: number): IdempotencyException {
  return new IdempotencyException({
    type: `${PROBLEM_BASE}-in-progress`,
    title: 'A request with this idempotency key is still being processed',
    status: HttpStatus.CONFLICT,
    detail: `Another request with the same ${headerName} has not finished yet. Retry after ${retryAfterSeconds} second(s) to receive its result.`,
  });
}
