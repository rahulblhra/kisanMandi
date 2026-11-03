import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AppSettings, AuditLog, Buyer, BuyerPayment, CommissionRule, Crop, Expense, Kisan, KisanPayment, PartySeasonSummary, Season, SyncMetadata, SyncQueueItem, Transaction, Variety } from '../../domain/models'

interface MandiDatabase extends DBSchema {
  kisans: { key: string; value: Kisan; indexes: { 'by-name': string; 'by-mobile': string; 'by-status': string } }
  buyers: { key: string; value: Buyer; indexes: { 'by-name': string; 'by-mobile': string; 'by-status': string } }
  crops: { key: string; value: Crop; indexes: { 'by-name': string; 'by-status': string } }
  varieties: { key: string; value: Variety; indexes: { 'by-crop': string; 'by-status': string } }
  commissionRules: { key: string; value: CommissionRule; indexes: { 'by-crop': string } }
  settings: { key: string; value: AppSettings }
  seasons: { key: string; value: Season; indexes: { 'by-start-date': string; 'by-status': string } }
  transactions: { key: string; value: Transaction; indexes: { 'by-season': string; 'by-arrival-date': string; 'by-status': string; 'by-kisan': string } }
  expenses: { key: string; value: Expense; indexes: { 'by-season': string; 'by-transaction': string } }
  buyerPayments: { key: string; value: BuyerPayment; indexes: { 'by-season': string; 'by-transaction': string; 'by-buyer': string } }
  kisanPayments: { key: string; value: KisanPayment; indexes: { 'by-season': string; 'by-transaction': string; 'by-kisan': string } }
  syncQueue: { key: string; value: SyncQueueItem; indexes: { 'by-status': string; 'by-created-at': string } }
  syncMetadata: { key: string; value: SyncMetadata }
  auditLogs: { key: string; value: AuditLog; indexes: { 'by-entity': [string, string]; 'by-timestamp': string } }
  partySeasonSummaries: { key: string; value: PartySeasonSummary; indexes: { 'by-party': [string, string]; 'by-season': string; 'by-party-season': [string, string, string] } }
}

let databasePromise: Promise<IDBPDatabase<MandiDatabase>> | undefined

export function getDatabase(): Promise<IDBPDatabase<MandiDatabase>> {
  if (!databasePromise) {
    databasePromise = openDB<MandiDatabase>('kisan-mandi', 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
        const kisans = db.createObjectStore('kisans', { keyPath: 'id' })
        kisans.createIndex('by-name', 'name')
        kisans.createIndex('by-mobile', 'mobile')
        kisans.createIndex('by-status', 'status')
        const buyers = db.createObjectStore('buyers', { keyPath: 'id' })
        buyers.createIndex('by-name', 'name')
        buyers.createIndex('by-mobile', 'mobile')
        buyers.createIndex('by-status', 'status')
        const crops = db.createObjectStore('crops', { keyPath: 'id' })
        crops.createIndex('by-name', 'name')
        crops.createIndex('by-status', 'status')
        const varieties = db.createObjectStore('varieties', { keyPath: 'id' })
        varieties.createIndex('by-crop', 'cropId')
        varieties.createIndex('by-status', 'status')
        const rules = db.createObjectStore('commissionRules', { keyPath: 'id' })
        rules.createIndex('by-crop', 'cropId')
        db.createObjectStore('settings', { keyPath: 'id' })
        const seasons = db.createObjectStore('seasons', { keyPath: 'id' })
        seasons.createIndex('by-start-date', 'startsOn')
        seasons.createIndex('by-status', 'status')
        const transactions = db.createObjectStore('transactions', { keyPath: 'id' })
        transactions.createIndex('by-season', 'seasonId')
        transactions.createIndex('by-arrival-date', 'arrivalDate')
        transactions.createIndex('by-status', 'transactionStatus')
        transactions.createIndex('by-kisan', 'kisanId')
        const expenses = db.createObjectStore('expenses', { keyPath: 'id' })
        expenses.createIndex('by-season', 'seasonId')
        expenses.createIndex('by-transaction', 'transactionId')
        const buyerPayments = db.createObjectStore('buyerPayments', { keyPath: 'id' })
        buyerPayments.createIndex('by-season', 'seasonId')
        buyerPayments.createIndex('by-transaction', 'transactionId')
        buyerPayments.createIndex('by-buyer', 'buyerId')
        const kisanPayments = db.createObjectStore('kisanPayments', { keyPath: 'id' })
        kisanPayments.createIndex('by-season', 'seasonId')
        kisanPayments.createIndex('by-transaction', 'transactionId')
        kisanPayments.createIndex('by-kisan', 'kisanId')
        const queue = db.createObjectStore('syncQueue', { keyPath: 'id' })
        queue.createIndex('by-status', 'status')
        queue.createIndex('by-created-at', 'createdAt')
        db.createObjectStore('syncMetadata', { keyPath: 'key' })
        }
        if (oldVersion < 2) {
          const auditLogs = db.createObjectStore('auditLogs', { keyPath: 'id' })
          auditLogs.createIndex('by-entity', ['entityType', 'entityId'])
          auditLogs.createIndex('by-timestamp', 'timestamp')
        }
        if (oldVersion < 3) {
          const summaries = db.createObjectStore('partySeasonSummaries', { keyPath: 'id' })
          summaries.createIndex('by-party', ['partyType', 'partyId'])
          summaries.createIndex('by-season', 'seasonId')
          summaries.createIndex('by-party-season', ['partyType', 'partyId', 'seasonId'])
        }
      },
    })
  }
  return databasePromise
}

export type { MandiDatabase }
