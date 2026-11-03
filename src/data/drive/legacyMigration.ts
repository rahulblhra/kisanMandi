import { getDatabase } from '../indexeddb/database'
import type { AppSettings, AuditLog, Buyer, BuyerPayment, Crop, Expense, Kisan, KisanPayment, PartySeasonSummary, Season, Transaction, Variety } from '../../domain/models'
import { buildPartySeasonSummaries } from '../../domain/calculations/statements'
import { DriveRepository, type MasterData, type SeasonData } from './driveRepository'

const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const now = () => new Date().toISOString()
function seasonForDate(date: string, seasons: Season[]): Season {
  const [year, month] = date.split('-').map(Number)
  if (!year || !month || month < 1 || month > 12) throw new Error(`Cannot migrate record with invalid date: ${date}`)
  const name = `${year}-${month <= 6 ? 'RABI' : 'KHARIF'}`
  const found = seasons.find((season) => season.name === name)
  if (found) return found
  const timestamp = now()
  const season: Season = { id: makeId('SEASON'), name, startsOn: `${year}-${month <= 6 ? '01-01' : '07-01'}`, endsOn: `${year}-${month <= 6 ? '06-30' : '12-31'}`, isClosed: false, status: 'INACTIVE', createdAt: timestamp, updatedAt: timestamp }
  seasons.push(season)
  return season
}

export async function migrateIndexedDbToDriveIfPresent(drive: DriveRepository): Promise<MasterData> {
  if (await drive.hasMasterFile()) return drive.loadMaster()
  const databases = await indexedDB.databases?.()
  if (!databases?.some((database) => database.name === 'kisan-mandi')) return { kisans: [], buyers: [], crops: [], varieties: [], seasons: [], settings: null, auditLogs: [] }

  const db = await getDatabase()
  const [kisans, buyers, crops, varieties, seasons, transactions, expenses, buyerPayments, kisanPayments, settings, auditLogs] = await Promise.all([
    db.getAll('kisans'), db.getAll('buyers'), db.getAll('crops'), db.getAll('varieties'), db.getAll('seasons'), db.getAll('transactions'), db.getAll('expenses'), db.getAll('buyerPayments'), db.getAll('kisanPayments'), db.get('settings', 'default'), db.getAll('auditLogs'),
  ]) as [Kisan[], Buyer[], Crop[], Variety[], Season[], Transaction[], Expense[], BuyerPayment[], KisanPayment[], AppSettings | undefined, AuditLog[]]

  const seasonList = [...seasons]
  const normalizedTransactions = transactions.map((row) => ({ ...row, seasonId: seasonForDate(row.arrivalDate, seasonList).id }))
  const normalizedBuyerPayments = buyerPayments.map((row) => ({ ...row, seasonId: seasonForDate(row.paymentDate, seasonList).id }))
  const normalizedKisanPayments = kisanPayments.map((row) => ({ ...row, seasonId: seasonForDate(row.paymentDate, seasonList).id }))
  const transactionById = new Map(normalizedTransactions.map((row) => [row.id, row]))
  const normalizedExpenses = expenses.map((row) => ({ ...row, seasonId: transactionById.get(row.transactionId)?.seasonId ?? row.seasonId }))
  const buckets = new Map<string, SeasonData>()
  for (const season of seasonList) buckets.set(season.id, { transactions: [], expenses: [], buyerPayments: [], kisanPayments: [] })
  for (const row of normalizedTransactions) buckets.get(row.seasonId)?.transactions.push(row)
  for (const row of normalizedExpenses) buckets.get(row.seasonId)?.expenses.push(row)
  for (const row of normalizedBuyerPayments) buckets.get(row.seasonId)?.buyerPayments.push(row)
  for (const row of normalizedKisanPayments) buckets.get(row.seasonId)?.kisanPayments.push(row)
  const partySeasonSummaries: PartySeasonSummary[] = []
  for (const season of seasonList) {
    const data = buckets.get(season.id)!
    partySeasonSummaries.push(...buildPartySeasonSummaries(data.transactions, data.expenses, data.buyerPayments, data.kisanPayments, now()))
    await drive.saveSeason(season.name, data)
  }
  const master: MasterData = { kisans, buyers, crops, varieties, seasons: seasonList, settings: settings ?? null, auditLogs }
  await Promise.all([
    drive.savePartySummaries('KISAN', partySeasonSummaries.filter((row) => row.partyType === 'KISAN')),
    drive.savePartySummaries('BUYER', partySeasonSummaries.filter((row) => row.partyType === 'BUYER')),
  ])
  await drive.saveMaster(master)

  // Clear the browser database only after every Drive file has been saved successfully.
  const stores = [...db.objectStoreNames]
  const clear = db.transaction(stores as never, 'readwrite')
  await Promise.all(stores.map((store) => clear.objectStore(store as never).clear()))
  await clear.done
  return master
}
