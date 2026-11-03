import type { Transaction } from '../models'

export interface SaleSettlement {
  grossSale: number
  commission: number
  labourCharge: number
  kisanPayable: number
  buyerReceivable: number
}

/** Pure financial calculation shared by UI and future reports. */
export function calculateSaleSettlement(transaction: Transaction): SaleSettlement | null {
  if (transaction.transactionStatus !== 'SOLD' || transaction.quantityKg == null || transaction.pricePerQuintal == null || transaction.commissionPercent == null) return null
  const grossSale = (transaction.quantityKg / 100) * transaction.pricePerQuintal
  const commission = grossSale * transaction.commissionPercent / 100
  const labourCharge = transaction.labourChargeTotal ?? 0
  return { grossSale, commission, labourCharge, kisanPayable: grossSale - commission - labourCharge, buyerReceivable: grossSale }
}

export function formatRupees(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount)
}
