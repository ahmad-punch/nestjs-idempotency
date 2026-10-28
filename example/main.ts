import 'reflect-metadata';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { Idempotent, IdempotencyModule, InMemoryIdempotencyStore } from '../src';

interface ChargeRequest {
  amount: number;
  currency: string;
}

@Controller('payments')
class PaymentsController {
  @Post()
  @Idempotent()
  charge(@Body() body: ChargeRequest): { id: string; amount: number; currency: string } {
    return { id: `pay_${randomUUID().slice(0, 8)}`, amount: body.amount, currency: body.currency };
  }
}

@Module({
  imports: [IdempotencyModule.forRoot({ store: new InMemoryIdempotencyStore(), ttlSeconds: 86_400 })],
  controllers: [PaymentsController],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.listen(port);
  console.log(`Example API listening on http://localhost:${port}`);
}

void bootstrap();
