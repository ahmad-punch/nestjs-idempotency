import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Idempotent } from '../src';

export interface PaymentRequest {
  amount: number;
  currency: string;
}

/** A promise that tests resolve by hand, to hold a handler mid-flight. */
export class Gate {
  private open!: () => void;
  private entered!: () => void;
  readonly opened = new Promise<void>((resolve) => (this.open = resolve));
  readonly reached = new Promise<void>((resolve) => (this.entered = resolve));

  async pass(): Promise<void> {
    this.entered();
    await this.opened;
  }

  release(): void {
    this.open();
  }
}

@Injectable()
export class PaymentsService {
  executions = 0;
  gate?: Gate;
  failNext = false;

  async charge(request: PaymentRequest): Promise<{ id: string; amount: number; currency: string }> {
    this.executions++;
    await this.gate?.pass();
    if (this.failNext) {
      this.failNext = false;
      throw new ServiceUnavailableException('Card network timed out');
    }
    return { id: `pay_${this.executions}`, amount: request.amount, currency: request.currency };
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @Idempotent()
  async create(
    @Body() body: PaymentRequest,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ): Promise<{ id: string; amount: number; currency: string }> {
    const payment = await this.payments.charge(body);
    res.setHeader('Location', `/payments/${payment.id}`);
    res.setHeader('X-Request-Cost', '3');
    return payment;
  }

  @Post('strict')
  @Idempotent({ requireKey: true })
  strict(@Body() body: PaymentRequest): Promise<unknown> {
    return this.payments.charge(body);
  }

  @Post('short-lived')
  @Idempotent({ ttlSeconds: 0.05 })
  shortLived(@Body() body: PaymentRequest): Promise<unknown> {
    return this.payments.charge(body);
  }

  @Post('accepted')
  @HttpCode(202)
  @Idempotent()
  accepted(@Body() body: PaymentRequest): Promise<unknown> {
    return this.payments.charge(body);
  }

  @Post('empty')
  @HttpCode(204)
  @Idempotent()
  async empty(@Body() body: PaymentRequest): Promise<void> {
    await this.payments.charge(body);
  }

  @Post('plain')
  plain(@Body() body: PaymentRequest): Promise<unknown> {
    return this.payments.charge(body);
  }
}

/** Stands in for Passport: trusts an `x-user-id` header. */
@Injectable()
export class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const userId = request.headers['x-user-id'];
    if (userId) {
      request.user = { id: userId };
    }
    return true;
  }
}
