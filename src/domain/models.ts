export type EntityStatus = 'ACTIVE' | 'INACTIVE'
export type QuantityUnit = 'KG' | 'MANN' | 'QUINTAL' | 'BAG'

export interface BaseRecord {
  id: string
  createdAt: string
  updatedAt: string
  status: EntityStatus
}

export interface Kisan extends BaseRecord {
  name: string
  mobile: string
  village: string
  address: string
}

export interface Buyer extends BaseRecord {
  name: string
  mobile: string
  address: string
}

export interface Crop extends BaseRecord {
  name: string
}

export interface Variety extends BaseRecord {
  cropId: string
  name: string
}

export interface CommissionRule extends BaseRecord {
  cropId: string
  varietyId?: string
  commissionPercent: number
}

export interface AppSettings extends BaseRecord {
  language?: 'HI' | 'EN'
  bagSizeKg: number
  defaultQuantityUnit: QuantityUnit
  commissionPercent: number
  labourChargePerBag: number
  organizationId: string
  mandiId: string
}

export interface Season extends BaseRecord {
  name: string
  startsOn: string
  endsOn: string
  isClosed: boolean
}

export interface Transaction extends BaseRecord {
  seasonId: string
  transactionNumber?: string
  kisanId: string
  buyerId?: string
  cropId: string
  varietyId?: string
  arrivalDate: string
  trolleyCount: number
  saleDate?: string
  quantityValue?: number
  quantityUnit?: QuantityUnit
  quantityKg?: number
  pricePerQuintal?: number
  commissionPercent?: number
  labourChargePerBag?: number
  labourChargeTotal?: number
  buyerDueDate?: string
  transactionStatus: 'ARRIVED' | 'SOLD' | 'CANCELLED'
}

export interface Expense extends BaseRecord {
  seasonId: string
  transactionId: string
  side: 'KISAN' | 'BUYER' | 'SELF'
  expenseType: 'LABOUR' | 'TRANSPORTATION' | 'MANDI_CHARGES' | 'OTHER'
  amount: number
  date: string
  description: string
}

export interface BuyerPayment extends BaseRecord {
  seasonId: string
  buyerId: string
  transactionId?: string
  transactionNumber?: string
  amount: number
  paymentDate: string
  paymentMethod: 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER'
  reference: string
}

export interface KisanPayment extends BaseRecord {
  seasonId: string
  kisanId: string
  transactionId?: string
  transactionNumber?: string
  amount: number
  paymentDate: string
  paymentMethod: 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER'
  reference: string
}

export interface PartySeasonSummary {
  id: string
  partyType: 'KISAN' | 'BUYER'
  partyId: string
  seasonId: string
  grossSales: number
  commission: number
  labourCharge: number
  expenses: number
  payments: number
  payableOrReceivable: number
  outstanding: number
  updatedAt: string
}

export interface AuditLog {
  id: string
  entityType: string
  entityId: string
  action: 'CREATE' | 'UPDATE' | 'VOID'
  timestamp: string
  details: Record<string, unknown>
}

export interface SyncQueueItem {
  id: string
  entityType: string
  entityId: string
  operation: 'CREATE' | 'UPDATE' | 'CANCEL'
  createdAt: string
  attempts: number
  status: 'PENDING' | 'FAILED'
}

export interface SyncMetadata {
  key: string
  value: string
  updatedAt: string
}
