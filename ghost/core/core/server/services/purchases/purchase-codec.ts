import { camelKeys, snakeKeys } from '../../lib/case-keys';
import {
  DbNewPurchase,
  DbPurchase,
  type NewPurchaseData,
  type NewPurchaseRow,
  type PurchaseData,
} from './purchase-schema';

export function decodePurchaseRow(input: unknown): PurchaseData {
  return camelKeys(DbPurchase.parse(input));
}

export function encodeNewPurchase(purchase: NewPurchaseData): NewPurchaseRow {
  return DbNewPurchase.parse(snakeKeys(purchase));
}
