import type { BuyerPayment, Expense, KisanPayment, PartySeasonSummary, Transaction } from '../models'
import { calculateSaleSettlement } from './financial'

export interface PartyStatement {
  grossSales: number
  commission: number
  labourCharge: number
  expenses: number
  payments: number
  payableOrReceivable: number
  outstanding: number
}

type PartySeasonKey = { partyType: 'KISAN' | 'BUYER'; partyId: string; seasonId: string }

export function buildPartySeasonSummaries(transactions: Transaction[], expenses: Expense[], buyerPayments: BuyerPayment[], kisanPayments: KisanPayment[], updatedAt: string): PartySeasonSummary[] {
  const keys = new Map<string, PartySeasonKey>()
  const summaries = new Map<string, PartySeasonSummary>()
  const keyFor = (partyType: PartySeasonKey['partyType'], partyId: string, seasonId: string) => {
    const id = `${partyType}|${partyId}|${seasonId}`
    if (!summaries.has(id)) summaries.set(id, { id, partyType, partyId, seasonId, grossSales: 0, commission: 0, labourCharge: 0, expenses: 0, payments: 0, payableOrReceivable: 0, outstanding: 0, updatedAt })
    keys.set(id, { partyType, partyId, seasonId })
    return summaries.get(id)!
  }

  for (const transaction of transactions) {
    if (transaction.transactionStatus === 'CANCELLED') continue
    const settlement = calculateSaleSettlement(transaction)
    const kisan = keyFor('KISAN', transaction.kisanId, transaction.seasonId)
    if (settlement) {
      kisan.grossSales += settlement.grossSale
      kisan.commission += settlement.commission
      kisan.labourCharge += settlement.labourCharge
    }
    if (transaction.buyerId) {
      const buyer = keyFor('BUYER', transaction.buyerId, transaction.seasonId)
      if (settlement) buyer.grossSales += settlement.grossSale
    }
  }
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]))
  for (const expense of expenses) {
    if (expense.status !== 'ACTIVE' || expense.side === 'SELF') continue
    const transaction = transactionById.get(expense.transactionId)
    const partyId = expense.side === 'KISAN' ? transaction?.kisanId : transaction?.buyerId
    if (!partyId) continue
    keyFor(expense.side, partyId, expense.seasonId).expenses += expense.amount
  }
  for (const payment of kisanPayments) if (payment.status === 'ACTIVE') keyFor('KISAN', payment.kisanId, payment.seasonId).payments += payment.amount
  for (const payment of buyerPayments) if (payment.status === 'ACTIVE') keyFor('BUYER', payment.buyerId, payment.seasonId).payments += payment.amount

  for (const [id, summary] of summaries) {
    const { partyType } = keys.get(id)!
    summary.payableOrReceivable = partyType === 'KISAN'
      ? summary.grossSales - summary.commission - summary.labourCharge - summary.expenses
      : summary.grossSales + summary.expenses
    summary.outstanding = summary.payableOrReceivable - summary.payments
  }
  return [...summaries.values()]
}

export function aggregatePartySeasonSummaries(kind: 'KISAN' | 'BUYER', partyId: string, summaries: PartySeasonSummary[]): PartyStatement {
  return summaries.filter((summary) => summary.partyType === kind && summary.partyId === partyId).reduce<PartyStatement>((total, summary) => ({
    grossSales: total.grossSales + summary.grossSales,
    commission: total.commission + summary.commission,
    labourCharge: total.labourCharge + summary.labourCharge,
    expenses: total.expenses + summary.expenses,
    payments: total.payments + summary.payments,
    payableOrReceivable: total.payableOrReceivable + summary.payableOrReceivable,
    outstanding: total.outstanding + summary.outstanding,
  }), { grossSales: 0, commission: 0, labourCharge: 0, expenses: 0, payments: 0, payableOrReceivable: 0, outstanding: 0 })
}

export function calculatePartyStatement(kind: 'KISAN' | 'BUYER', partyId: string, transactions: Transaction[], expenses: Expense[], payments: (KisanPayment | BuyerPayment)[]): PartyStatement {
  const matching = transactions.filter((transaction) => kind === 'KISAN' ? transaction.kisanId === partyId : transaction.buyerId === partyId)
  const transactionIds = new Set(matching.map((transaction) => transaction.id))
  const sales = matching.map(calculateSaleSettlement).filter((value) => value !== null)
  const grossSales = sales.reduce((sum, value) => sum + value.grossSale, 0)
  const commission = sales.reduce((sum, value) => sum + value.commission, 0)
  const labourCharge = sales.reduce((sum, value) => sum + value.labourCharge, 0)
  const partyExpenses = expenses.filter((expense) => expense.status === 'ACTIVE' && transactionIds.has(expense.transactionId) && expense.side === kind).reduce((sum, expense) => sum + expense.amount, 0)
  const partyPayments = payments.filter((payment) => payment.status === 'ACTIVE' && (kind === 'KISAN' ? 'kisanId' in payment && payment.kisanId === partyId : 'buyerId' in payment && payment.buyerId === partyId)).reduce((sum, payment) => sum + payment.amount, 0)
  const payableOrReceivable = kind === 'KISAN' ? grossSales - commission - labourCharge - partyExpenses : grossSales + partyExpenses
  return { grossSales, commission, labourCharge, expenses: partyExpenses, payments: partyPayments, payableOrReceivable, outstanding: payableOrReceivable - partyPayments }
}
