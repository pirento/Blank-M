/**
 * Zod schemas and size limits for the read-only broker portfolio response.
 */
import { z } from 'zod';

export const BROKER_PORTFOLIO_MAX_ROWS = 5000;
export const BROKER_PORTFOLIO_MAX_BYTES = 4 * 1024 * 1024;
const label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9 _./&^=:+-]+$/);
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 100);
const timestamp = z.string().datetime();
const instrument = { symbol: label, exchange: label };

export const brokerHoldingSchema = z.object({
  ...instrument,
  isin: z
    .string()
    .regex(/^[A-Z0-9]{12}$/)
    .nullable(),
  quantity,
  t1Quantity: quantity.nullable(),
  usedQuantity: quantity.nullable(),
  averagePrice: money,
  lastPrice: money,
});
export const brokerPositionSchema = z.object({
  ...instrument,
  product: label,
  quantity: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  averagePrice: money,
  lastPrice: money,
});
export const brokerOrderSchema = z.object({
  ...instrument,
  orderId: id,
  product: label,
  side: z.enum(['BUY', 'SELL']),
  status: label,
  orderType: label,
  quantity,
  filledQuantity: quantity,
  pendingQuantity: quantity,
  cancelledQuantity: quantity,
  price: money,
  averagePrice: money,
  placedAt: timestamp.nullable(),
});
export const brokerTradeSchema = z.object({
  ...instrument,
  tradeId: id,
  orderId: id,
  product: label,
  side: z.enum(['BUY', 'SELL']),
  quantity: quantity.positive(),
  averagePrice: money,
  filledAt: timestamp.nullable(),
});
export const brokerPortfolioSchema = z.object({
  source: z.literal('kite'),
  currency: z.literal('INR'),
  startedAt: timestamp,
  fetchedAt: timestamp,
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  holdings: z.array(brokerHoldingSchema).max(BROKER_PORTFOLIO_MAX_ROWS),
  positions: z.object({
    net: z.array(brokerPositionSchema).max(BROKER_PORTFOLIO_MAX_ROWS),
    day: z.array(brokerPositionSchema).max(BROKER_PORTFOLIO_MAX_ROWS),
  }),
  orders: z.array(brokerOrderSchema).max(BROKER_PORTFOLIO_MAX_ROWS),
  trades: z.array(brokerTradeSchema).max(BROKER_PORTFOLIO_MAX_ROWS),
});
