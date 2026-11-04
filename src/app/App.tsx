import { Children, cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, ArrowDownToLine, BarChart3, Boxes, ChevronDown, ClipboardList, Cloud, Download, Home, Leaf, LogOut, Moon, MoreHorizontal, Plus, Search, Settings2, Sun, Users, X } from 'lucide-react'
import { useAuth } from '../auth/AuthGate'
import { DriveRepository, type BackupStatus, type MasterData, type SeasonData } from '../data/drive/driveRepository'
import { migrateIndexedDbToDriveIfPresent } from '../data/drive/legacyMigration'
import { calculateSaleSettlement, formatRupees } from '../domain/calculations/financial'
import { aggregatePartySeasonSummaries, buildPartySeasonSummaries } from '../domain/calculations/statements'
import type { AppSettings, AuditLog, Buyer, BuyerPayment, Crop, Expense, Kisan, KisanPayment, PartySeasonSummary, Season, Transaction, Variety } from '../domain/models'

type Page = 'Dashboard' | 'Arrivals' | 'Kisans' | 'Buyers' | 'Crops & Varieties' | 'Expenses' | 'Reports' | 'Seasons' | 'Audit history' | 'Settings'
type ReportKind = 'UNSOLD_ARRIVALS' | 'DAILY_SALE' | 'KISAN_BALANCES' | 'BUYER_BALANCES'
const navItems: { label: Page; icon: typeof Home }[] = [
  { label: 'Dashboard', icon: Home }, { label: 'Arrivals', icon: Boxes },
  { label: 'Kisans', icon: Users }, { label: 'Buyers', icon: Users },
  { label: 'Crops & Varieties', icon: Boxes },
  { label: 'Expenses', icon: ArrowDownToLine },
  { label: 'Reports', icon: BarChart3 }, { label: 'Seasons', icon: Leaf }, { label: 'Audit history', icon: Activity },
]
const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const stamp = () => new Date().toISOString()
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const downloadCsv = (filename: string, rows: (string | number)[][]) => {
  const escapeCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`
  const csv = `\uFEFF${rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const transactionNumberPrefix = (arrivalDate: string, kisanMobile: string, cropName: string, varietyName: string | undefined) => {
  const slug = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16).replace(/-$/g, '') || 'NA'
  return `${arrivalDate}~${kisanMobile}~${slug(cropName)}~${slug(varietyName || 'NO-VARIETY')}`
}
const transactionNumberFromDetails = (arrivalDate: string, kisanMobile: string, cropName: string, varietyName: string | undefined, suffix: string) => `${transactionNumberPrefix(arrivalDate, kisanMobile, cropName, varietyName)}~${suffix}`
const randomSuffixStart = () => {
  const bytes = new Uint8Array(1)
  do { crypto.getRandomValues(bytes) } while (bytes[0] >= 200)
  return bytes[0] % 100
}
const uniqueTransactionNumber = (arrivalDate: string, kisanMobile: string, cropName: string, varietyName: string | undefined, existing: Transaction[], preferredStart?: number) => {
  const existingNumbers = new Set(existing.map((row) => row.transactionNumber).filter((value): value is string => Boolean(value)))
  const start = preferredStart ?? randomSuffixStart()
  for (let offset = 0; offset < 100; offset += 1) {
    const suffix = String((start + offset) % 100).padStart(2, '0')
    const candidate = transactionNumberFromDetails(arrivalDate, kisanMobile, cropName, varietyName, suffix)
    if (!existingNumbers.has(candidate)) return candidate
  }
  throw new Error('All transaction number suffixes 00–99 are already used for this Kisan, crop, variety and arrival date.')
}
const transactionNumberFor = (transaction: Transaction) => transaction.transactionNumber || `TXN-${transaction.id.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toUpperCase()}`
const isCurrentTransactionNumberFormat = (number: string | undefined) => Boolean(number && /^\d{4}-\d{2}-\d{2}~\d{10,15}~[^~]+~[^~]+~\d{2}$/.test(number))
const assignMissingTransactionNumbers = (transactions: Transaction[], kisans: Kisan[], crops: Crop[], varieties: Variety[]) => {
  const used = new Set<string>()
  const counts = new Map<string, number>()
  for (const row of transactions) if (isCurrentTransactionNumberFormat(row.transactionNumber)) counts.set(row.transactionNumber!, (counts.get(row.transactionNumber!) ?? 0) + 1)
  const reserved = new Set([...counts].filter(([, count]) => count === 1).map(([number]) => number))
  const next = transactions.map((row) => {
    const numberIsLegacy = !isCurrentTransactionNumberFormat(row.transactionNumber) || counts.get(row.transactionNumber!) !== 1 || used.has(row.transactionNumber!)
    if (!numberIsLegacy) { used.add(row.transactionNumber!); return row }
    const kisanMobile = kisans.find((item) => item.id === row.kisanId)?.mobile.replace(/\D/g, '') ?? row.kisanId
    const cropName = crops.find((item) => item.id === row.cropId)?.name ?? row.cropId
    const varietyName = varieties.find((item) => item.id === row.varietyId)?.name
    const start = randomSuffixStart()
    for (let offset = 0; offset < 100; offset += 1) {
      const suffix = String((start + offset) % 100).padStart(2, '0')
      const candidate = transactionNumberFromDetails(row.arrivalDate, kisanMobile, cropName, varietyName, suffix)
      if (!used.has(candidate) && !reserved.has(candidate)) { used.add(candidate); return { ...row, transactionNumber: candidate } }
    }
    throw new Error(`Could not assign a unique transaction number to arrival ${row.arrivalDate}.`)
  })
  return next
}
const greetingForHour = (hour: number) => hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Good night'
const hi: Record<string, string> = Object.assign({}, { Dashboard:'डैशबोर्ड'}, {Arrivals:'आवक'}, {Kisans:'किसान'}, {Buyers:'खरीदार'}, {'Crops & Varieties':'फसलें और किस्में'}, {Expenses:'खर्चे'}, {Reports:'रिपोर्ट'}, {Seasons:'सीज़न'}, {Settings:'सेटिंग्स'}, {Workspace:'कार्यस्थल'}, {'New arrival':'नई आवक'}, {'New Arrival':'नई आवक'}, {'Unsold arrivals':'बिना बिकी आवक'}, {'Record an arrival':'आवक दर्ज करें'}, {'Today at a glance':'आज की झलक'}, {'Quick actions':'त्वरित कार्य'}, {'Print report':'रिपोर्ट प्रिंट करें'}, {'Save settings':'सेटिंग्स सहेजें'}, {'Select season':'सीज़न चुनें'}, {'No season selected':'कोई सीज़न नहीं चुना'}, {'Default quantity unit':'डिफ़ॉल्ट मात्रा इकाई'}, {'Default bag size (kg)':'डिफ़ॉल्ट बोरी का वजन (किलो)'}, {'Default commission (%)':'डिफ़ॉल्ट कमीशन (%)'}, {'Default labour charge per bag (₹)':'प्रति बोरी डिफ़ॉल्ट मजदूरी (₹)'}, {'Search farmer or crop':'किसान या फसल खोजें'}, {'No arrivals in this season':'इस सीज़न में कोई आवक नहीं'}, {'Sold':'बिकी हुई'}, {'Unsold':'बिना बिकी'}, {'Language':'भाषा'}, {'Hindi':'हिन्दी'}, {'English':'अंग्रेज़ी'}, {'COMMISSION AGENT':'कमीशन एजेंट'}, {'Workspace':'कार्यस्थल'}, {'profile':'प्रोफ़ाइल'}, {'Sign out':'साइन आउट'}, {'Search records':'रिकॉर्ड खोजें'}, {'Good morning':'सुप्रभात'}, {'Good afternoon':'नमस्कार'}, {'Good evening':'शुभ संध्या'}, {'Good night':'शुभ रात्रि'}, {'Here’s what’s happening in your mandi today.':'आज आपकी मंडी में क्या हो रहा है।'}, {'Your workspace is ready':'आपका कार्यक्षेत्र तैयार है'}, {'Connecting to Google Drive':'गूगल ड्राइव से जुड़ रहा है'}, {'Saved to Drive':'ड्राइव में सहेजा गया'}, {'Updating Google Drive…':'गूगल ड्राइव अपडेट हो रहा है…'}, {'TROLLEYS ARRIVED TODAY':'आज आई ट्रॉलियाँ'}, {'KISANS TODAY':'आज के किसान'}, {'ARRIVALS TODAY':'आज की आवक'}, {'Across today’s arrivals':'आज की आवक का कुल'}, {'Farmers with arrivals':'आवक वाले किसान'}, {'Lots recorded today':'आज दर्ज लॉट'}, {'Record quantity when produce is sold':'माल बिकने पर मात्रा दर्ज करें'}, {'View all →':'सभी देखें →'}, {'arrivals waiting':'आवक बिक्री की प्रतीक्षा में'}, {'All caught up!':'सब अपडेट है!'}, {'New unsold arrivals will appear here.':'नई बिना बिकी आवक यहाँ दिखेगी।'}, {'Today’s activity':'आज की गतिविधि'}, {'Jump right into your daily work.':'अपने दैनिक काम शुरू करें।'}, {'Find a kisan':'किसान खोजें'}, {'Find a buyer':'खरीदार खोजें'}, {'Open kisan directory':'किसान सूची खोलें'}, {'Open buyer directory':'खरीदार सूची खोलें'}, {'Manage seasons':'सीज़न प्रबंधित करें'}, {'Master data':'मास्टर डेटा'}, {'Add crop':'फसल जोड़ें'}, {'Add variety':'किस्म जोड़ें'}, {'Edit':'संपादित करें'}, {'Edit crop':'फसल संपादित करें'}, {'No varieties added':'कोई किस्म नहीं जोड़ी गई'}, {'Search crops or varieties...':'फसल या किस्म खोजें...'}, {'Settings':'सेटिंग्स'}, {'Quantity}, {commission & labour':'मात्रा}, {कमीशन और मजदूरी'}, {'Current conversion:':'वर्तमान रूपांतरण:'}, {'Google Drive backups':'गूगल ड्राइव बैकअप'}, {'Back up now':'अभी बैकअप लें'}, {'Clear all data':'सभी डेटा हटाएँ'}, {'Expenses':'खर्चे'}, {'Add expense':'खर्च जोड़ें'}, {'Search party}, {crop or description':'पार्टी}, {फसल या विवरण खोजें'}, {'Reports':'रिपोर्ट'}, {'Date':'तारीख'}, {'Amount (₹)':'राशि (₹)'}, {'Payment date':'भुगतान की तारीख'}, {'Payment method':'भुगतान का तरीका'}, {'Reference / note':'संदर्भ / टिप्पणी'}, {'Save payment':'भुगतान सहेजें'}, {'Save sale':'बिक्री सहेजें'}, {'Save arrival':'आवक सहेजें'}, {'Cancel':'रद्द करें'}, {'Save correction':'सुधार सहेजें'}, {'Transaction (optional)':'लेन-देन (वैकल्पिक)'}, {'No specific transaction':'कोई विशिष्ट लेन-देन नहीं'}, {'Transaction history':'लेन-देन इतिहास'}, {'Payments':'भुगतान'}, {'Season balances':'सीज़न शेष'}, {'Sales value':'बिक्री राशि'}, {'Commission':'कमीशन'}, {'Labour':'मजदूरी'}, {'Total payable':'कुल देय'}, {'Payments made':'किए गए भुगतान'}, {'Balance to pay':'भुगतान शेष'}, {'Buyer receivable':'खरीदार से प्राप्ति'}, {'Total receivable':'कुल प्राप्ति'}, {'Payments received':'प्राप्त भुगतान'}, {'Balance to receive':'प्राप्ति शेष'}, {'Arrival date':'आवक की तारीख'}, {'Sale date':'बिक्री की तारीख'}, {'Quantity':'मात्रा'}, {'Price / Qtl':'दर / क्विंटल'}, {'Crop / variety':'फसल / किस्म'}, {'Transaction no.':'लेन-देन क्रमांक'}, {'No Kisans to report.':'रिपोर्ट के लिए किसान नहीं हैं।'}, {'No Buyers to report.':'रिपोर्ट के लिए खरीदार नहीं हैं।'}, {'No unsold arrivals in':'इस सीज़न में बिना बिकी आवक नहीं है'}, {'Kisan Balances':'किसान बकाया'}, {'Buyer Balances':'खरीदार बकाया'}, {'Unsold Arrivals':'बिना बिकी आवक'}, {'Current Season Daily Sale':'वर्तमान सीज़न की दैनिक बिक्री' })
Object.assign(hi, {  'crops shown':'फसलें दिखाई गईं', 'variety':'किस्म', 'varieties':'किस्में', 'records':'रिकॉर्ड', 'ACCOUNT ENTRIES':'खाता प्रविष्टियाँ', 'ACTIVE':'सक्रिय', 'DATE / SEASON':'तारीख / सीज़न', 'PARTY / ACCOUNT':'पार्टी / खाता', 'TRANSACTION':'लेन-देन', 'TYPE / NOTE':'प्रकार / टिप्पणी', 'AMOUNT':'राशि', 'STATUS / ACTION':'स्थिति / कार्य', 'Search party, crop or description':'पार्टी, फसल या विवरण खोजें', 'Record expenses against sales and choose whether they affect a Kisan, Buyer, or the Agent.':'बिक्री पर खर्च दर्ज करें और चुनें कि यह किसान, खरीदार या एजेंट के खाते को प्रभावित करेगा।', 'Add expense':'खर्च जोड़ें', 'Edit':'संपादित करें', 'Void':'रद्द करें', 'VOIDED':'रद्द', 'TRANSPORTATION':'परिवहन', 'MANDI CHARGES':'मंडी शुल्क', 'LABOUR':'मजदूरी', 'OTHER':'अन्य', 'KISAN':'किसान', 'BUYER':'खरीदार', 'SELF':'स्वयं', 'Agent (Self)':'एजेंट (स्वयं)', 'Unknown party':'अज्ञात पार्टी', 'Unknown transaction':'अज्ञात लेन-देन', 'Crop':'फसल', 'No expenses recorded':'कोई खर्च दर्ज नहीं है', 'Add an expense to track its effect on a party balance.':'पार्टी के बकाया पर प्रभाव देखने के लिए खर्च जोड़ें।', 'Seasons':'सीज़न', 'Crops & Varieties':'फसलें और किस्में'  })
Object.assign(hi, { 'Track every lot received, its trolley count and sale status.':'हर प्राप्त लॉट और ट्रॉली संख्या दर्ज करें तथा बिक्री की स्थिति देखें।', 'arrivals':'आवक', 'ARRIVAL':'आवक', 'CROP / VARIETY':'फसल / किस्म', 'TROLLEYS / QTY':'ट्रॉलियाँ / मात्रा', 'STATUS / ACTION':'स्थिति / कार्य', 'View amounts':'राशि देखें', 'Edit arrival':'आवक संपादित करें', 'Record sale':'बिक्री दर्ज करें', 'Record an arrival':'आवक दर्ज करें', 'Unknown kisan':'अज्ञात किसान', 'Unknown crop':'अज्ञात फसल', 'trolley':'ट्रॉली', 'trolleys':'ट्रॉलियाँ', 'Qtl':'क्विंटल', 'REPORTS':'रिपोर्ट', 'Operational and balance reports from your mandi records.':'मंडी के रिकॉर्ड से संचालन और बकाया रिपोर्ट देखें।', 'Print report':'रिपोर्ट प्रिंट करें', 'Choose report':'रिपोर्ट चुनें', 'Sale date':'बिक्री की तारीख', 'Generated':'बनाई गई', 'UNSOLD LOTS':'बिना बिकी खेप', 'TROLLEYS WAITING':'प्रतीक्षारत ट्रॉलियाँ', 'KISANS':'किसान', 'SALES':'बिक्री', 'QUANTITY SOLD':'बिकी मात्रा', 'SALES VALUE':'बिक्री राशि', 'COMMISSION':'कमीशन', 'LABOUR':'मजदूरी', 'TOTAL PAYABLE':'कुल देय', 'PAYMENTS MADE':'किए गए भुगतान', 'BALANCE TO PAY':'भुगतान शेष', 'TOTAL RECEIVABLE':'कुल प्राप्ति', 'PAYMENTS RECEIVED':'प्राप्त भुगतान', 'BALANCE TO RECEIVE':'प्राप्ति शेष', 'ARRIVAL DATE':'आवक की तारीख', 'TRANSACTION NO.':'लेन-देन क्रमांक', 'KISAN':'किसान', 'BUYER':'खरीदार', 'MOBILE':'मोबाइल', 'TROLLEYS':'ट्रॉलियाँ', 'TRANSACTION':'लेन-देन', 'QUANTITY':'मात्रा', 'RATE / QTL':'दर / क्विंटल', 'KISAN PAYABLE':'किसान को देय', 'BUYER RECEIVABLE':'खरीदार से प्राप्ति', 'EXPENSES':'खर्च', 'TOTAL':'कुल', 'Total trolleys waiting':'कुल प्रतीक्षारत ट्रॉलियाँ', 'Daily total':'दैनिक कुल', 'No sales recorded':'कोई बिक्री दर्ज नहीं है', 'No unsold arrivals':'कोई बिना बिकी आवक नहीं है', 'No Kisans to report.':'रिपोर्ट के लिए किसान नहीं हैं।', 'No Buyers to report.':'रिपोर्ट के लिए खरीदार नहीं हैं।', 'Lifetime totals across all seasons · Calculated from season summaries':'सभी सीज़न का कुल · सीज़न सारांश से गणना', 'KisanMandi':'किसानमंडी' })
const seasonDetailsForDate = (date: string) => {
  const [year, month] = date.split('-').map(Number)
  const rabi = month <= 6
  return { name: `${year}-${rabi ? 'RABI' : 'KHARIF'}`, startsOn: `${year}-${rabi ? '01-01' : '07-01'}`, endsOn: `${year}-${rabi ? '06-30' : '12-31'}` }
}

Object.assign(hi, { 'Audit history': 'ऑडिट इतिहास', 'Season': 'सीज़न', 'Crop': 'फसल', 'From': 'से', 'To': 'तक', 'All seasons': 'सभी सीज़न', 'All crops': 'सभी फसलें', 'Export CSV': 'CSV डाउनलोड', 'Export transactions CSV': 'लेन-देन CSV', 'Kisan': 'किसान', 'Buyer': 'खरीदार', 'Mobile': 'मोबाइल', 'Trolleys': 'ट्रॉलियाँ' })

export default function App() {
  const { user, signOut, reauthorize } = useAuth()
  const drive = useMemo(() => new DriveRepository(user.accessToken), [user.accessToken])
  const [active, setActive] = useState<Page>('Dashboard')
  const [seasons, setSeasons] = useState<Season[]>([])
  const [kisans, setKisans] = useState<Kisan[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [varieties, setVarieties] = useState<Variety[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [buyerPayments, setBuyerPayments] = useState<BuyerPayment[]>([])
  const [kisanPayments, setKisanPayments] = useState<KisanPayment[]>([])
  const [partySeasonSummaries, setPartySeasonSummaries] = useState<PartySeasonSummary[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const hindiUi = settings?.language === 'HI'
  const t = (text: string) => hindiUi ? hi[text] ?? text : text
  const [selectedSeason, setSelectedSeason] = useState('')
  const selectedSeasonRef = useRef('')
  const currentSeasonCache = useRef<{ seasonId: string; seasonName: string; data: SeasonData } | null>(null)
  const [dbReady, setDbReady] = useState(false)
  const [clockNow, setClockNow] = useState(() => new Date())
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const submissionIds = useRef(new WeakMap<HTMLFormElement, string>())
  const submissionSuffixes = useRef(new WeakMap<HTMLFormElement, number>())
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('kisan-mandi-theme') === 'dark' ? 'dark' : 'light')
  const [clearingData, setClearingData] = useState(false)
  const [reauthorizing, setReauthorizing] = useState(false)
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupStatusLoading, setBackupStatusLoading] = useState(false)
  const [backupStatusError, setBackupStatusError] = useState('')
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [reportKind, setReportKind] = useState<ReportKind>('UNSOLD_ARRIVALS')
  const [reportDate, setReportDate] = useState(today())
  const [reportEndDate, setReportEndDate] = useState(today())
  const [arrivalTab, setArrivalTab] = useState<'ARRIVED' | 'SOLD'>('ARRIVED')
  const [modal, setModal] = useState<'kisan' | 'buyer' | 'crop' | 'variety' | 'arrival' | 'sale' | 'settlement' | 'payment' | 'expense' | 'paymentEdit' | 'expenseEdit' | 'kisanEdit' | 'buyerEdit' | 'cropEdit' | 'varietyEdit' | null>(null)
  const [partyEditTarget, setPartyEditTarget] = useState<Kisan | Buyer | null>(null)
  const [cropEditTarget, setCropEditTarget] = useState<Crop | null>(null)
  const [varietyEditTarget, setVarietyEditTarget] = useState<Variety | null>(null)
  const [defaultVarietyCropId, setDefaultVarietyCropId] = useState('')
  const [saleTarget, setSaleTarget] = useState<Transaction | null>(null)
  const [arrivalTarget, setArrivalTarget] = useState<Transaction | null>(null)
  const [settlementTarget, setSettlementTarget] = useState<Transaction | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<KisanPayment | BuyerPayment | null>(null)
  const [expenseTarget, setExpenseTarget] = useState<Expense | null>(null)
  const [selectedParty, setSelectedParty] = useState<{ kind: 'KISAN' | 'BUYER'; id: string } | null>(null)

  const refresh = useCallback(async (requestedSeasonId?: string) => {
    let master = await migrateIndexedDbToDriveIfPresent(drive)
    const summaryMigration = await drive.migrateLegacySeasonSummaries(master)
    master = summaryMigration.master
    const systemSeasonName = seasonDetailsForDate(today()).name
    if (currentSeasonCache.current && currentSeasonCache.current.seasonName !== systemSeasonName) currentSeasonCache.current = null
    const preferredSeasonId = requestedSeasonId || selectedSeasonRef.current
    const selected = master.seasons.find((season) => season.id === preferredSeasonId)
    let season = selected ?? master.seasons.find((item) => item.name === systemSeasonName) ?? master.seasons.find((item) => item.status === 'ACTIVE')
    if (!season) {
      const details = seasonDetailsForDate(today()); const now = stamp()
      season = { id: makeId('SEASON'), ...details, isClosed: false, status: 'ACTIVE', createdAt: now, updatedAt: now }
      master = { ...master, seasons: [...master.seasons, season] }
      await drive.saveMaster(master)
    }
    let seasonData: SeasonData
    if (season.name === systemSeasonName && currentSeasonCache.current?.seasonName === systemSeasonName && currentSeasonCache.current.seasonId === season.id) {
      seasonData = currentSeasonCache.current.data
    } else {
      seasonData = await drive.loadSeason(season.name)
      if (season.name === systemSeasonName) currentSeasonCache.current = { seasonId: season.id, seasonName: season.name, data: seasonData }
    }
    const numberedTransactions = assignMissingTransactionNumbers(seasonData.transactions, master.kisans, master.crops, master.varieties)
    if (numberedTransactions.some((row, index) => row.transactionNumber !== seasonData.transactions[index]?.transactionNumber)) {
      seasonData = { ...seasonData, transactions: numberedTransactions }
      await drive.saveSeason(season.name, seasonData)
      if (season.name === systemSeasonName) currentSeasonCache.current = { seasonId: season.id, seasonName: season.name, data: seasonData }
    }
    const now = stamp()
    const appSettings: AppSettings = master.settings ?? { id: 'default', bagSizeKg: 50, defaultQuantityUnit: 'QUINTAL', commissionPercent: 2, labourChargePerBag: 0, organizationId: 'local', mandiId: 'local', status: 'ACTIVE', createdAt: now, updatedAt: now }
    if (!master.settings) { master = { ...master, settings: appSettings }; await drive.saveMaster(master) }
    const summaries = summaryMigration.summaries
    setSeasons([...master.seasons].sort((a, b) => b.startsOn.localeCompare(a.startsOn)))
    setKisans(master.kisans); setBuyers(master.buyers); setCrops(master.crops); setVarieties(master.varieties); setTransactions(seasonData.transactions)
    setExpenses(seasonData.expenses); setBuyerPayments(seasonData.buyerPayments); setKisanPayments(seasonData.kisanPayments)
    setPartySeasonSummaries(summaries); setAuditLogs(master.auditLogs ?? []); setSettings(appSettings); selectedSeasonRef.current = season.id; setSelectedSeason(season.id); setDbReady(true)
  }, [drive])

  const loadTransactionsForAllSeasons = useCallback(() => drive.loadTransactionsForSeasons(seasons.map((season) => season.name)), [drive, seasons])
  const refreshBackupStatus = useCallback(async () => {
    setBackupStatusLoading(true); setBackupStatusError('')
    try { setBackupStatus(await drive.getLatestBackupStatus()) }
    catch (reason) { setBackupStatusError(reason instanceof Error ? reason.message : 'Could not load backup status.') }
    finally { setBackupStatusLoading(false) }
  }, [drive])

  const saveMasterRecord = async <K extends 'kisans' | 'buyers' | 'crops' | 'varieties' | 'seasons'>(collection: K, record: MasterData[K][number]) => {
    const master = await drive.loadMaster()
    const rows = master[collection] as { id: string }[]
    const existed = rows.some((row) => row.id === (record as { id: string }).id)
    const next = existed
      ? rows.map((row) => row.id === (record as { id: string }).id ? record : row)
      : [...rows, record]
    await drive.saveMaster({ ...master, [collection]: next })
    if (!existed) await writeAudit(({ kisans: 'KISAN', buyers: 'BUYER', crops: 'CROP', varieties: 'VARIETY', seasons: 'SEASON' } as const)[collection], (record as { id: string }).id, 'CREATE', { after: record })
  }

  const saveSeasonData = async (seasonId: string, update: (data: SeasonData) => SeasonData) => {
    const master = await drive.loadMaster()
    const season = master.seasons.find((row) => row.id === seasonId)
    if (!season) throw new Error('The selected season is missing from Google Drive.')
    const systemSeasonName = seasonDetailsForDate(today()).name
    if (currentSeasonCache.current && currentSeasonCache.current.seasonName !== systemSeasonName) currentSeasonCache.current = null
    const existing = season.name === systemSeasonName && currentSeasonCache.current?.seasonId === seasonId
      ? currentSeasonCache.current.data
      : await drive.loadSeason(season.name)
    const next = update(existing)
    const summary = buildPartySeasonSummaries(next.transactions, next.expenses, next.buyerPayments, next.kisanPayments, stamp())
    await drive.saveSeason(season.name, next)
    await drive.updatePartySummariesForSeason(seasonId, summary)
    if (season.name === seasonDetailsForDate(today()).name) currentSeasonCache.current = { seasonId, seasonName: season.name, data: next }
  }

  const writeAudit = async (entityType: string, entityId: string, action: AuditLog['action'], details: Record<string, unknown>) => {
    const timestamp = stamp()
    const log: AuditLog = { id: makeId('AUDIT'), entityType, entityId, action, timestamp, actorEmail: user.email, actorProfile: user.profile, details }
    try {
      const master = await drive.loadMaster()
      const next = [...master.auditLogs, log]
      await drive.saveMaster({ ...master, auditLogs: next })
      setAuditLogs(next)
      return true
    } catch {
      setError('The record was saved, but it could not be added to the audit history. Please try again later.')
      return false
    }
  }

  const finishSave = async (message: string, seasonId?: string) => {
    setModal(null); setToast(message)
    try { await refresh(seasonId) }
    catch (reason) { setError(`Saved to Google Drive, but the screen could not refresh: ${reason instanceof Error ? reason.message : 'Please refresh the page.'}`) }
  }

  const runButtonAction = async (action: () => Promise<void>, event: React.MouseEvent<HTMLButtonElement>) => {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    const button = event.currentTarget; const originalLabel = button.textContent ?? 'Save'
    button.disabled = true; button.textContent = 'Updating…'
    try { await action() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this change.') }
    finally { savingRef.current = false; setSaving(false); if (button.isConnected) { button.disabled = false; button.textContent = originalLabel } }
  }

  const reconnectGoogle = async () => {
    setReauthorizing(true)
    try { await reauthorize(); setError('Google reconnected. Your form is still here; retry the save.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not reconnect Google.') }
    finally { setReauthorizing(false) }
  }

  useEffect(() => { refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Google Drive could not be opened. Please refresh and try again.')) }, [refresh])
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.lang = settings?.language === 'HI' ? 'hi' : 'en'; localStorage.setItem('kisan-mandi-theme', theme) }, [theme, settings?.language])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 2600); return () => window.clearTimeout(timer) }, [toast])
  useEffect(() => { const timer = window.setInterval(() => setClockNow(new Date()), 60_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { if (currentSeasonCache.current && currentSeasonCache.current.seasonName !== seasonDetailsForDate(today()).name) currentSeasonCache.current = null }, [clockNow])

  const currentSeason = seasons.find((season) => season.id === selectedSeason)
  const canRecordOps = user.profile === 'editor'
  const canCorrectOps = user.profile === 'editor'
  const canManageMoney = user.profile === 'editor'
  const isAdmin = user.profile === 'editor'
  useEffect(() => { if (active === 'Settings' && isAdmin) void refreshBackupStatus() }, [active, isAdmin, refreshBackupStatus])
  const seasonTransactions = useMemo(() => transactions.filter((row) => row.seasonId === selectedSeason && row.transactionStatus !== 'CANCELLED'), [transactions, selectedSeason])
  const todayTransactions = seasonTransactions.filter((row) => row.arrivalDate === today())
  const unsold = seasonTransactions.filter((row) => row.transactionStatus === 'ARRIVED')
  const filteredKisans = kisans.filter((row) => `${row.name} ${row.mobile} ${row.village}`.toLowerCase().includes(search.toLowerCase()))
  const filteredBuyers = buyers.filter((row) => `${row.name} ${row.mobile}`.toLowerCase().includes(search.toLowerCase()))
  const filteredAuditLogs = auditLogs.filter((row) => `${row.entityType} ${row.entityId} ${row.action} ${row.actorEmail ?? ''}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const createMaster = async (kind: 'kisan' | 'buyer', form: FormData) => {
    const now = stamp()
    const name = String(form.get('name')).trim().replace(/\s+/g, ' ')
    if (!name) throw new Error('Name is required.')
    const normalizedName = name.toLocaleLowerCase()
    const mobile = String(form.get('mobile')).trim().replace(/\D/g, '')
    if (!/^\d{10,15}$/.test(mobile)) throw new Error('Enter a mobile number with at least 10 digits (digits only).')
    const editTarget = partyEditTarget
    const sameSide = kind === 'kisan' ? kisans : buyers
    const duplicateMobile = sameSide.find((row) => row.id !== editTarget?.id && row.mobile.replace(/\D/g, '') === mobile)
    const originalMobile = editTarget?.mobile.replace(/\D/g, '')
    if (duplicateMobile && (!editTarget || originalMobile !== mobile)) throw new Error(`Mobile number ${mobile} is already assigned to ${duplicateMobile.name} as a ${kind === 'kisan' ? 'Kisan' : 'Buyer'}. Each ${kind === 'kisan' ? 'Kisan' : 'Buyer'} must have a unique mobile number.`)
    const activeMatches = sameSide.filter((row) => row.status === 'ACTIVE' && row.id !== editTarget?.id)
    const matchingName = activeMatches.find((row) => row.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === normalizedName)
    if (matchingName && !window.confirm(`A ${kind === 'kisan' ? 'Kisan' : 'Buyer'} named “${matchingName.name}” already exists with a different mobile number. Different people can share a name. Save anyway?`)) return
    if (kind === 'kisan') {
      const row: Kisan = { id: editTarget?.id ?? String(form.get('__submissionId') || makeId('K')), name, mobile, village: String(form.get('village')).trim(), address: String(form.get('address')).trim(), status: editTarget?.status ?? 'ACTIVE', createdAt: editTarget?.createdAt ?? now, updatedAt: now }
      if (!row.name || !row.mobile) throw new Error('Name and mobile number are required.')
      const master = await drive.loadMaster(); await drive.saveMaster({ ...master, kisans: [...master.kisans.filter((item) => item.id !== row.id), row] })
      await writeAudit('KISAN', row.id, editTarget ? 'UPDATE' : 'CREATE', editTarget ? { before: editTarget, after: row } : { after: row })
    } else {
      const row: Buyer = { id: editTarget?.id ?? String(form.get('__submissionId') || makeId('B')), name, mobile, address: String(form.get('address')).trim(), status: editTarget?.status ?? 'ACTIVE', createdAt: editTarget?.createdAt ?? now, updatedAt: now }
      if (!row.name || !row.mobile) throw new Error('Name and mobile number are required.')
      const master = await drive.loadMaster(); await drive.saveMaster({ ...master, buyers: [...master.buyers.filter((item) => item.id !== row.id), row] })
      await writeAudit('BUYER', row.id, editTarget ? 'UPDATE' : 'CREATE', editTarget ? { before: editTarget, after: row } : { after: row })
    }
    setPartyEditTarget(null); await finishSave(editTarget ? `${kind === 'kisan' ? 'Kisan' : 'Buyer'} details corrected.` : `${kind === 'kisan' ? 'Kisan' : 'Buyer'} saved to Google Drive.`)
  }

  const createCrop = async (form: FormData) => {
    const name = String(form.get('name')).trim().toUpperCase()
    if (!name) throw new Error('Enter a crop name.')
    if (crops.some((crop) => crop.id !== cropEditTarget?.id && crop.name.toLowerCase() === name.toLowerCase())) throw new Error('This crop already exists.')
    const now = stamp(); const row: Crop = { id: cropEditTarget?.id ?? String(form.get('__submissionId') || makeId('CROP')), name, status: cropEditTarget?.status ?? 'ACTIVE', createdAt: cropEditTarget?.createdAt ?? now, updatedAt: now }
    await saveMasterRecord('crops', row); if (cropEditTarget) await writeAudit('CROP', row.id, 'UPDATE', { before: cropEditTarget, after: row }); setCropEditTarget(null); await finishSave(cropEditTarget ? 'Crop corrected.' : `${name} crop saved to Google Drive.`)
  }

  const createVariety = async (form: FormData) => {
    const cropId = varietyEditTarget?.cropId ?? String(form.get('cropId')); const name = String(form.get('name')).trim()
    if (!cropId || !name) throw new Error('Select a crop and enter a variety name.')
    if (varieties.some((variety) => variety.id !== varietyEditTarget?.id && variety.cropId === cropId && variety.name.toLowerCase() === name.toLowerCase())) throw new Error('This variety already exists for the selected crop.')
    const now = stamp(); const row: Variety = { id: varietyEditTarget?.id ?? String(form.get('__submissionId') || makeId('VAR')), cropId, name, status: varietyEditTarget?.status ?? 'ACTIVE', createdAt: varietyEditTarget?.createdAt ?? now, updatedAt: now }
    await saveMasterRecord('varieties', row); if (varietyEditTarget) await writeAudit('VARIETY', row.id, 'UPDATE', { before: varietyEditTarget, after: row }); setVarietyEditTarget(null); await finishSave(varietyEditTarget ? 'Variety corrected.' : `${name} variety saved to Google Drive.`)
  }

  const ensureSeasonForDate = async (date: string) => {
    const parsed = new Date(`${date}T00:00:00`)
    const matchesLocalDate = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}` === date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || !matchesLocalDate) throw new Error('Enter a valid arrival date.')
    const details = seasonDetailsForDate(date)
    const master = await drive.loadMaster()
    const existing = master.seasons.find((season) => season.name === details.name)
    if (existing) return existing.id
    const now = stamp(); const season: Season = { id: makeId('SEASON'), ...details, isClosed: false, status: 'INACTIVE', createdAt: now, updatedAt: now }
    await drive.saveMaster({ ...master, seasons: [...master.seasons, season] })
    await writeAudit('SEASON', season.id, 'CREATE', { after: season })
    return season.id
  }

  const createArrival = async (form: FormData) => {
    const trolleyCount = Number(form.get('trolleyCount'))
    if (!form.get('kisanId') || !form.get('cropId') || !Number.isInteger(trolleyCount) || trolleyCount <= 0) throw new Error('Select a kisan and crop, then enter at least one trolley.')
    const arrivalDate = String(form.get('arrivalDate'))
    const duplicate = transactions.find((row) => row.id !== arrivalTarget?.id && row.transactionStatus !== 'CANCELLED' && row.kisanId === String(form.get('kisanId')) && row.cropId === String(form.get('cropId')) && (row.varietyId ?? '') === String(form.get('varietyId') || '') && row.arrivalDate === arrivalDate)
    if (duplicate && !window.confirm('A matching arrival already exists for this Kisan, crop, variety and date. Record another arrival anyway?')) return
    const seasonId = await ensureSeasonForDate(arrivalDate)
    const seasonName = seasonDetailsForDate(arrivalDate).name
    const now = stamp(); const transactionId = arrivalTarget?.id ?? String(form.get('__submissionId') || makeId('TXN'))
    const destinationData = seasonName === seasonDetailsForDate(today()).name && currentSeasonCache.current?.seasonName === seasonName
      ? currentSeasonCache.current.data
      : await drive.loadSeason(seasonName)
    const kisanMobile = kisans.find((item) => item.id === String(form.get('kisanId')))?.mobile.replace(/\D/g, '') ?? String(form.get('kisanId'))
    const cropName = crops.find((item) => item.id === String(form.get('cropId')))?.name ?? String(form.get('cropId'))
    const varietyName = varieties.find((item) => item.id === String(form.get('varietyId') || ''))?.name
    const existingNumber = arrivalTarget ? transactionNumberFor(arrivalTarget) : ''
    const transactionNumber = arrivalTarget && arrivalTarget.seasonId === seasonId && existingNumber.startsWith(`${transactionNumberPrefix(arrivalDate, kisanMobile, cropName, varietyName)}~`)
      ? existingNumber
      : uniqueTransactionNumber(arrivalDate, kisanMobile, cropName, varietyName, destinationData.transactions.filter((row) => row.id !== transactionId), Number(form.get('__transactionSuffix')))
    const row: Transaction = arrivalTarget ? {
      ...arrivalTarget, seasonId, kisanId: String(form.get('kisanId')), cropId: String(form.get('cropId')),
      transactionNumber, varietyId: String(form.get('varietyId') || '') || undefined, arrivalDate,
      trolleyCount, updatedAt: now,
    } : {
      id: transactionId, transactionNumber, seasonId, kisanId: String(form.get('kisanId')), cropId: String(form.get('cropId')),
      varietyId: String(form.get('varietyId') || '') || undefined, arrivalDate,
      trolleyCount, transactionStatus: 'ARRIVED',
      status: 'ACTIVE', createdAt: now, updatedAt: now,
    }
    const priorSeasonId = arrivalTarget?.seasonId
    let movedExpenses: Expense[] = []
    if (priorSeasonId && priorSeasonId !== seasonId) {
      const master = await drive.loadMaster(); const previousSeason = master.seasons.find((item) => item.id === priorSeasonId)
      if (previousSeason) movedExpenses = (await drive.loadSeason(previousSeason.name)).expenses.filter((item) => item.transactionId === row.id).map((item) => ({ ...item, seasonId, updatedAt: now }))
      await saveSeasonData(priorSeasonId, (data) => ({ ...data, transactions: data.transactions.filter((item) => item.id !== row.id), expenses: data.expenses.filter((item) => item.transactionId !== row.id) }))
    }
    await saveSeasonData(seasonId, (data) => ({ ...data, transactions: [...data.transactions.filter((item) => item.id !== row.id), row], expenses: [...data.expenses.filter((item) => item.transactionId !== row.id), ...movedExpenses] }))
    await writeAudit('TRANSACTION', row.id, arrivalTarget ? 'UPDATE' : 'CREATE', arrivalTarget ? { before: arrivalTarget, after: row } : { after: row })
    setArrivalTarget(null); setSelectedSeason(seasonId); await finishSave(arrivalTarget ? 'Arrival corrected and saved.' : 'Arrival saved to Google Drive.', seasonId)
  }

  const undoSale = async (transaction: Transaction) => {
    if (!window.confirm('Reopen this sale as an unsold arrival? Sale quantity, price and liability will be cleared, and the correction will be logged.')) return
    const updated: Transaction = { ...transaction, buyerId: undefined, saleDate: undefined, quantityValue: undefined, quantityUnit: undefined, quantityKg: undefined, pricePerQuintal: undefined, commissionPercent: undefined, labourChargePerBag: undefined, labourChargeTotal: undefined, buyerDueDate: undefined, transactionStatus: 'ARRIVED', updatedAt: stamp() }
    await saveSeasonData(transaction.seasonId, (data) => ({ ...data, transactions: data.transactions.map((item) => item.id === updated.id ? updated : item) })); await writeAudit('TRANSACTION', transaction.id, 'UPDATE', { before: transaction, after: updated, reason: 'SALE_REOPENED' }); await finishSave('Sale reopened as an unsold arrival.', transaction.seasonId)
  }

  const createSale = async (form: FormData) => {
    if (!saleTarget) throw new Error('Select an arrival to sell.')
    const buyerId = String(form.get('buyerId') || '')
    if (!buyerId) throw new Error('Select a buyer so the receivable is included in that buyer’s statement.')
    const quantityValue = Number(form.get('quantityValue')); const unit = String(form.get('quantityUnit')) as NonNullable<Transaction['quantityUnit']>
    const pricePerQuintal = Number(form.get('pricePerQuintal'))
    const commissionPercent = Number(form.get('commissionPercent'))
    const multipliers = { KG: 1, MANN: 40, QUINTAL: 100, BAG: settings?.bagSizeKg ?? 50 }
    if (!Number.isFinite(quantityValue) || quantityValue <= 0 || !Number.isFinite(pricePerQuintal) || pricePerQuintal <= 0 || !Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) throw new Error('Quantity and price must be greater than zero. Commission must be between 0 and 100%.')
    const saleDate = String(form.get('saleDate'))
    if (saleDate < saleTarget.arrivalDate) throw new Error('Sale date cannot be before arrival date.')
    const quantityKg = quantityValue * multipliers[unit]
    const labourChargePerBag = Number(form.get('labourChargePerBag'))
    if (!Number.isFinite(labourChargePerBag) || labourChargePerBag < 0) throw new Error('Labour charge per bag cannot be negative.')
    const labourChargeTotal = quantityKg / (settings?.bagSizeKg ?? 50) * labourChargePerBag
    const updated: Transaction = { ...saleTarget, buyerId, saleDate, quantityValue, quantityUnit: unit, quantityKg, pricePerQuintal, commissionPercent, labourChargePerBag, labourChargeTotal, buyerDueDate: String(form.get('buyerDueDate') || '') || undefined, transactionStatus: 'SOLD', updatedAt: stamp() }
    await saveSeasonData(updated.seasonId, (data) => ({ ...data, transactions: data.transactions.map((item) => item.id === updated.id ? updated : item) }))
    await writeAudit('TRANSACTION', updated.id, 'UPDATE', { before: saleTarget, after: updated })
    setSaleTarget(null); await finishSave('Sale details corrected and saved.', updated.seasonId)
  }

  const validateTransactionPayment = async (transactionId: string | undefined, partyType: 'KISAN' | 'BUYER', partyId: string, amount: number, excludePaymentId?: string) => {
    if (!transactionId) return
    const seasonNames = seasons.map((season) => season.name)
    const transaction = transactions.find((row) => row.id === transactionId) ?? await drive.findTransactionById(transactionId, seasonNames)
    if (!transaction || transaction.transactionStatus !== 'SOLD' || (partyType === 'KISAN' ? transaction.kisanId !== partyId : transaction.buyerId !== partyId)) throw new Error('Choose a completed sale for this party, or leave the transaction blank.')
    const settlement = calculateSaleSettlement(transaction)
    if (!settlement) throw new Error('This sale is missing its amount details and cannot be linked to a payment.')
    const transactionAmount = partyType === 'KISAN' ? settlement.kisanPayable : settlement.buyerReceivable
    const linkedPayments = await drive.loadPaymentsForTransaction(transactionId, partyType, seasonNames)
    const alreadyPaid = linkedPayments.filter((payment) => payment.status === 'ACTIVE' && payment.id !== excludePaymentId).reduce((total, payment) => total + payment.amount, 0)
    const exactRemaining = Math.max(0, transactionAmount - alreadyPaid)
    const remainingRoundedToTen = Math.round(exactRemaining / 10) * 10
    if (amount > remainingRoundedToTen + 0.005) {
      throw new Error(`This payment would exceed the ${partyType === 'KISAN' ? 'Kisan payable' : 'Buyer receivable'} for ${transactionNumberFor(transaction)}. Remaining amount after rounding to ₹10: ${formatRupees(remainingRoundedToTen)}.`)
    }
  }

  const editPayment = async (form: FormData) => {
    if (!paymentTarget) throw new Error('Select a payment to edit.')
    const enteredAmount = Number(form.get('amount')); const paymentDate = String(form.get('paymentDate'))
    if (!Number.isFinite(enteredAmount) || enteredAmount <= 0 || !paymentDate) throw new Error('Enter a valid payment amount and date.')
    const amount = Math.round(enteredAmount / 10) * 10
    if (amount <= 0) throw new Error('Payment amount must round to at least ₹10.')
    const seasonId = await ensureSeasonForDate(paymentDate)
    const transactionId = String(form.get('transactionId') || '') || undefined
    const linkedTransaction = transactionId ? transactions.find((row) => row.id === transactionId) : undefined
    await validateTransactionPayment(transactionId, 'kisanId' in paymentTarget ? 'KISAN' : 'BUYER', 'kisanId' in paymentTarget ? paymentTarget.kisanId : paymentTarget.buyerId, amount, paymentTarget.id)
    const updated = { ...paymentTarget, amount, paymentDate, seasonId, transactionId, transactionNumber: linkedTransaction ? transactionNumberFor(linkedTransaction) : transactionId === paymentTarget.transactionId ? paymentTarget.transactionNumber : undefined, paymentMethod: String(form.get('paymentMethod')) as KisanPayment['paymentMethod'], reference: String(form.get('reference') || ''), updatedAt: stamp() }
    const oldSeasonId = paymentTarget.seasonId
    if (oldSeasonId !== seasonId) await saveSeasonData(oldSeasonId, (data) => ({ ...data, kisanPayments: data.kisanPayments.filter((row) => row.id !== updated.id), buyerPayments: data.buyerPayments.filter((row) => row.id !== updated.id) }))
    await saveSeasonData(seasonId, (data) => 'kisanId' in updated ? ({ ...data, kisanPayments: [...data.kisanPayments.filter((row) => row.id !== updated.id), updated as KisanPayment] }) : ({ ...data, buyerPayments: [...data.buyerPayments.filter((row) => row.id !== updated.id), updated as BuyerPayment] }))
    await writeAudit('PAYMENT', updated.id, 'UPDATE', { before: paymentTarget, after: updated })
    setPaymentTarget(null); setSelectedSeason(seasonId); await finishSave('Payment corrected and saved.', seasonId)
  }

  const voidPayment = async (payment: KisanPayment | BuyerPayment) => {
    if (!window.confirm('Void this payment? It will remain in the statement history and be removed from the balance calculation.')) return
    const updated = { ...payment, status: 'INACTIVE' as const, updatedAt: stamp() }
    await saveSeasonData(payment.seasonId, (data) => 'kisanId' in payment ? ({ ...data, kisanPayments: data.kisanPayments.map((row) => row.id === payment.id ? updated as KisanPayment : row) }) : ({ ...data, buyerPayments: data.buyerPayments.map((row) => row.id === payment.id ? updated as BuyerPayment : row) }))
    await writeAudit('PAYMENT', payment.id, 'VOID', { before: payment, after: updated })
    await finishSave('Payment voided; history retained.', payment.seasonId)
  }

  const saveSettings = async (form: FormData) => {
    const bagSizeKg = Number(form.get('bagSizeKg')); const commissionPercent = Number(form.get('commissionPercent')); const labourChargePerBag = Number(form.get('labourChargePerBag')); const defaultQuantityUnit = String(form.get('defaultQuantityUnit')) as NonNullable<Transaction['quantityUnit']>
    if (!Number.isFinite(bagSizeKg) || bagSizeKg <= 0) throw new Error('Bag size must be greater than zero.')
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) throw new Error('Commission must be between 0 and 100%.')
    if (!Number.isFinite(labourChargePerBag) || labourChargePerBag < 0) throw new Error('Labour charge per bag cannot be negative.')
    if (!['KG', 'MANN', 'QUINTAL', 'BAG'].includes(defaultQuantityUnit)) throw new Error('Choose a valid default quantity unit.')
    const language = String(form.get('language') || settings?.language || 'EN') as 'HI' | 'EN'
    const now = stamp(); const saved: AppSettings = { ...(settings ?? { id: 'default', bagSizeKg: 50, defaultQuantityUnit: 'QUINTAL', commissionPercent: 2, labourChargePerBag: 0, organizationId: 'local', mandiId: 'local', status: 'ACTIVE', createdAt: now, updatedAt: now }), bagSizeKg, defaultQuantityUnit, commissionPercent, labourChargePerBag, language, updatedAt: now }
    const master = await drive.loadMaster(); await drive.saveMaster({ ...master, settings: saved }); await writeAudit('SETTINGS', 'default', settings ? 'UPDATE' : 'CREATE', settings ? { before: settings, after: saved } : { after: saved }); setSettings(saved); setToast('Settings saved to Google Drive.')
  }

  const clearAllDriveData = async () => {
    if (!window.confirm('Permanently delete all data inside the KisanMandi folder in your Google Drive? This includes every season, arrival, sale, payment, expense, party, crop, variety, summary, and setting. This cannot be undone.')) return
    setClearingData(true); setError('')
    try {
      await drive.createBackupNow()
      await drive.clearAllData()
      currentSeasonCache.current = null; selectedSeasonRef.current = ''; setSelectedParty(null); setSelectedSeason(''); setActive('Dashboard')
      await refresh()
      setToast('All KisanMandi Drive data was cleared. A fresh empty season is ready.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not clear KisanMandi data from Google Drive.')
    } finally { setClearingData(false) }
  }

  const createPayment = async (form: FormData) => {
    if (!selectedParty) throw new Error('Select a party first.')
    const enteredAmount = Number(form.get('amount')); const paymentDate = String(form.get('paymentDate'))
    if (!Number.isFinite(enteredAmount) || enteredAmount <= 0 || !paymentDate) throw new Error('Enter a valid payment amount and date.')
    const amount = Math.round(enteredAmount / 10) * 10
    if (amount <= 0) throw new Error('Payment amount must round to at least ₹10.')
    const seasonId = await ensureSeasonForDate(paymentDate)
    const transactionId = String(form.get('transactionId') || '') || undefined
    const linkedTransaction = transactionId ? transactions.find((row) => row.id === transactionId) : undefined
    await validateTransactionPayment(transactionId, selectedParty.kind, selectedParty.id, amount)
    const balance = aggregatePartySeasonSummaries(selectedParty.kind, selectedParty.id, partySeasonSummaries).outstanding
    if (amount > Math.max(0, balance) + 0.005 && !window.confirm(`This payment is more than the current balance of ${formatRupees(Math.max(0, balance))}. Record it anyway?`)) return
    const now = stamp(); const common = { id: String(form.get('__submissionId') || makeId(selectedParty.kind === 'KISAN' ? 'KP' : 'BP')), seasonId, transactionId, transactionNumber: linkedTransaction ? transactionNumberFor(linkedTransaction) : undefined, amount, paymentDate, paymentMethod: String(form.get('paymentMethod')) as 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER', reference: String(form.get('reference') || ''), status: 'ACTIVE' as const, createdAt: now, updatedAt: now }
    await saveSeasonData(seasonId, (data) => selectedParty.kind === 'KISAN' ? ({ ...data, kisanPayments: [...data.kisanPayments.filter((row) => row.id !== common.id), { ...common, kisanId: selectedParty.id }] }) : ({ ...data, buyerPayments: [...data.buyerPayments.filter((row) => row.id !== common.id), { ...common, buyerId: selectedParty.id }] }))
    await writeAudit('PAYMENT', common.id, 'CREATE', { after: { ...common, partyType: selectedParty.kind, partyId: selectedParty.id } })
    await finishSave('Payment recorded to Google Drive.', seasonId)
  }

  const createExpense = async (form: FormData) => {
    const transactionId = String(form.get('transactionId')); const amount = Number(form.get('amount')); const date = String(form.get('date'))
    const transaction = transactions.find((row) => row.id === transactionId)
    if (!transaction || transaction.transactionStatus !== 'SOLD' || !Number.isFinite(amount) || amount <= 0 || !date) throw new Error('Select a completed sale and enter a valid expense.')
    const side = (selectedParty?.kind ?? String(form.get('side') || expenseTarget?.side)) as Expense['side']
    if (side !== 'KISAN' && side !== 'BUYER' && side !== 'SELF') throw new Error('Choose whose account this expense affects.')
    if (side === 'BUYER' && !transaction.buyerId) throw new Error('This sale has no buyer linked yet.')
    const now = stamp(); const row: Expense = expenseTarget ? { ...expenseTarget, transactionId, seasonId: transaction.seasonId, side, expenseType: String(form.get('expenseType')) as Expense['expenseType'], amount, date, description: String(form.get('description') || ''), updatedAt: now } : { id: String(form.get('__submissionId') || makeId('EXP')), seasonId: transaction.seasonId, transactionId, side, expenseType: String(form.get('expenseType')) as Expense['expenseType'], amount, date, description: String(form.get('description') || ''), status: 'ACTIVE', createdAt: now, updatedAt: now }
    await saveSeasonData(transaction.seasonId, (data) => ({ ...data, expenses: [...data.expenses.filter((item) => item.id !== row.id), row] }))
    await writeAudit('EXPENSE', row.id, expenseTarget ? 'UPDATE' : 'CREATE', expenseTarget ? { before: expenseTarget, after: row } : { after: row })
    setExpenseTarget(null); await finishSave(expenseTarget ? 'Expense corrected and saved.' : 'Expense recorded.', transaction.seasonId)
  }

  const voidExpense = async (expense: Expense) => {
    if (!window.confirm('Void this expense? It will remain in history but will no longer affect the balance.')) return
    const updated = { ...expense, status: 'INACTIVE' as const, updatedAt: stamp() }
    await saveSeasonData(expense.seasonId, (data) => ({ ...data, expenses: data.expenses.map((row) => row.id === expense.id ? updated : row) })); await writeAudit('EXPENSE', expense.id, 'VOID', { before: expense, after: updated }); await finishSave('Expense voided; history retained.', expense.seasonId)
  }

  const submit = (action: (data: FormData) => Promise<void>) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    const form = event.currentTarget
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const originalLabel = button?.textContent ?? 'Save'
    if (button) { button.disabled = true; button.textContent = 'Updating…' }
    let submissionId = submissionIds.current.get(form)
    if (!submissionId) { submissionId = makeId('ENTRY'); submissionIds.current.set(form, submissionId) }
    let suffix = submissionSuffixes.current.get(form)
    if (suffix === undefined) { suffix = randomSuffixStart(); submissionSuffixes.current.set(form, suffix) }
    const data = new FormData(form); data.set('__submissionId', submissionId); data.set('__transactionSuffix', String(suffix))
    try { await action(data); submissionIds.current.delete(form); submissionSuffixes.current.delete(form) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this record. Your form data is still here; correct the issue or retry.') }
    finally {
      savingRef.current = false; setSaving(false)
      if (button?.isConnected) { button.disabled = false; button.textContent = originalLabel }
    }
  }

  const toggleActiveSeason = async (season: Season) => {
    const master = await drive.loadMaster(); const now = stamp()
    const updated = { ...season, status: 'ACTIVE' as const, updatedAt: now }
    await drive.saveMaster({ ...master, seasons: master.seasons.map((item) => ({ ...item, status: item.id === season.id ? 'ACTIVE' : 'INACTIVE', updatedAt: now })) })
    await writeAudit('SEASON', season.id, 'UPDATE', { before: season, after: updated, reason: 'ACTIVE_SEASON_CHANGED' })
    setSelectedSeason(season.id); await finishSave(`${season.name} selected.`, season.id)
  }

  const arrivalRows = seasonTransactions.filter((row) => `${kisans.find((k) => k.id === row.kisanId)?.name} ${crops.find((c) => c.id === row.cropId)?.name} ${varieties.find((v) => v.id === row.varietyId)?.name ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const displayedArrivalRows = arrivalRows.filter((row) => row.transactionStatus === arrivalTab)
  const unsoldArrivalCount = seasonTransactions.filter((row) => row.transactionStatus === 'ARRIVED').length
  const soldArrivalCount = seasonTransactions.filter((row) => row.transactionStatus === 'SOLD').length
  const pageTitle = active
  const navigate = (page: Page) => { setActive(page); setSearch(''); setError(''); setMobileMoreOpen(false); if (page === 'Kisans' || page === 'Buyers' || (page !== active)) setSelectedParty(null) }
  const pageAvailable = (label: Page) => (label !== 'Expenses' || isAdmin) && (label !== 'Settings' || isAdmin) && (label !== 'Seasons' || isAdmin) && (label !== 'Crops & Varieties' || isAdmin) && (label !== 'Audit history' || isAdmin)
  const visibleNavItems = navItems.filter(({ label }) => pageAvailable(label))
  const mobilePrimaryPages: Page[] = ['Dashboard', 'Arrivals', 'Kisans', 'Buyers']
  const mobileMoreItems = visibleNavItems.filter(({ label }) => !mobilePrimaryPages.includes(label))

  return <Localize language={settings?.language ?? 'EN'}><div lang={settings?.language === 'HI' ? 'hi' : 'en'} className={`app-shell role-${user.profile}`}>
    <aside className="sidebar">
      <button className="brand brand-button" onClick={() => navigate('Dashboard')}><span className="brand-mark"><Leaf size={20} /></span><span>Kisan<span className="brand-light">Mandi</span><small>COMMISSION AGENT</small></span></button>
      <div className="nav-label">{t('Workspace').toUpperCase()}</div>
      <nav>{visibleNavItems.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${active === label ? 'selected' : ''}`} onClick={() => navigate(label)} aria-label={t(label)} title={t(label)}><Icon size={18} strokeWidth={1.8} /><span>{t(label)}</span>{label === 'Arrivals' && <span className="nav-count">{seasonTransactions.length}</span>}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="profile profile-button"><span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span><span><strong>{user.name}</strong><small>{user.profile} profile</small></span></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{pageTitle}</strong></div><div className="topbar-actions"><label className="season-select"><Leaf size={16} /><select value={selectedSeason} onChange={(event) => { const seasonId = event.target.value; setSelectedSeason(seasonId); refresh(seasonId).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load that season from Google Drive.')) }} aria-label="Select season"><option value="">No season selected</option>{seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select><ChevronDown size={15} /></label><div className="offline-pill"><span className="online-dot" /> {user.email} · {user.profile}</div><button className="icon-button signout-button mobile-hide-action" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={16} /></button><button className="icon-button search-shortcut" aria-label="Search records" onClick={() => navigate(active === 'Kisans' || active === 'Buyers' ? active : 'Arrivals')}><Search size={18} /></button><button className="icon-button theme-shortcut" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button>{isAdmin && <button className="icon-button settings-shortcut" aria-label="Settings" onClick={() => navigate('Settings')}><Settings2 size={18} /></button>}</div></header>
      <div className="content">
        {error && <div className="notice error" role="alert"><span>{error}</span>{error.includes('sign-in expired') && <button className="secondary-button" onClick={reconnectGoogle} disabled={reauthorizing}>{reauthorizing ? 'Reconnecting…' : 'Reconnect Google'}</button>}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {active !== 'Dashboard' && !isAdmin && ['Crops & Varieties', 'Expenses', 'Seasons', 'Settings'].includes(active) ? <div className='panel coming-panel'><h2>Viewer profile</h2><p>This section is available in Editor profile.</p><button className='secondary-button' onClick={() => navigate('Dashboard')}>Back to dashboard</button></div> : null}
        {active === 'Dashboard' && <>
          <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-dot" /> {clockNow.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()} <span className="eyebrow-divider">/</span> {currentSeason?.name ?? 'NO SEASON YET'}</div><h1>{greetingForHour(clockNow.getHours())}, {user.name.trim() || user.email.split('@')[0]} <span className="wave">{clockNow.getHours() < 17 ? '☀' : '☾'}</span></h1><p className="subtitle">Here’s what’s happening in your mandi today.</p></div>{canRecordOps && <button className="primary-button" onClick={() => setModal('arrival')}><Plus size={16}/> New Arrival</button>}</div>
          <div className="status-strip"><div className="status-icon"><Activity size={17} /></div><span>{dbReady ? 'Your workspace is ready' : 'Connecting to Google Drive'}</span><span className="status-divider">·</span><Cloud size={15} /><span>Google Drive</span><span className="status-divider">·</span><span className="safe-dot" /> {saving ? 'Updating Google Drive…' : 'Saved to Drive'}</div>
          <section className="section-heading"><div><h2>Today at a glance</h2><p>Daily activity overview · quantities only</p></div><span className="text-button static-label">{today()}</span></section>
          <div className="metric-grid">
            <article className="metric-card"><div className="metric-top"><span className="metric-icon green"><Boxes size={18} /></span><span className="metric-kicker">TROLLEYS ARRIVED TODAY</span></div><div className="metric-value">{todayTransactions.reduce((sum, row) => sum + row.trolleyCount, 0)}</div><div className="metric-bottom"><span className="muted">Across today’s arrivals</span></div></article>
            <article className="metric-card"><div className="metric-top"><span className="metric-icon blue"><Users size={18} /></span><span className="metric-kicker">KISANS TODAY</span></div><div className="metric-value">{new Set(todayTransactions.map((row) => row.kisanId)).size}</div><div className="metric-bottom"><span className="muted">Farmers with arrivals</span></div></article>
            <article className="metric-card"><div className="metric-top"><span className="metric-icon orange"><ClipboardList size={18} /></span><span className="metric-kicker">ARRIVALS TODAY</span></div><div className="metric-value">{todayTransactions.length}</div><div className="metric-bottom"><span className="muted">Lots recorded today</span></div></article>
          </div>
          <div className="lower-grid"><section className="panel arrivals-panel"><div className="panel-heading"><div><h2>Unsold arrivals</h2><p>Record quantity when produce is sold</p></div><button className="text-button" onClick={() => navigate('Arrivals')}>View all →</button></div><div className="arrival-total"><strong>{unsold.length}</strong><span>arrivals waiting</span><span className="quantity-badge">{unsold.reduce((sum, row) => sum + (row.trolleyCount ?? 0), 0)} trolleys</span></div>{unsold.length ? <div className="record-list">{unsold.slice(0, 5).map((row) => <div className="record-row" key={row.id}><span className="record-bullet"/><span><strong>{kisans.find((k) => k.id === row.kisanId)?.name ?? 'Kisan'}</strong><small>{crops.find((crop) => crop.id === row.cropId)?.name ?? 'Crop'} · {row.arrivalDate}</small></span><b>{row.trolleyCount ?? '—'} trolley{row.trolleyCount === 1 ? '' : 's'}</b></div>)}</div> : <div className="empty-state compact-empty"><strong>All caught up!</strong><p>New unsold arrivals will appear here.</p><button onClick={() => setModal('arrival')}>Record an arrival →</button></div>}</section><section className="panel due-panel"><div className="panel-heading"><div><h2>Today’s activity</h2><p>Local records in {currentSeason?.name ?? 'this season'}</p></div></div><div className="due-summary"><div className="due-stat"><span className="due-icon due-today"><Users size={16}/></span><span>Kisans</span><strong>{kisans.length}</strong></div><div className="due-stat"><span className="due-icon overdue"><Boxes size={16}/></span><span>Buyers</span><strong>{buyers.length}</strong></div></div><div className="quick-links"><button onClick={() => navigate('Kisans')}>Open kisan directory <span>→</span></button><button onClick={() => navigate('Buyers')}>Open buyer directory <span>→</span></button><button onClick={() => navigate('Seasons')}>Manage seasons <span>→</span></button></div></section></div>
          <section className="quick-section"><div className="quick-heading"><div><h2>Quick actions</h2><p>Jump right into your daily work.</p></div></div><div className="quick-grid">{canRecordOps && <button className="quick-card" onClick={() => setModal('arrival')}><span className="quick-icon green"><Plus size={18}/></span><span><strong>New arrival</strong><small>Record produce from a kisan</small></span><span className="quick-arrow">→</span></button>}<button className="quick-card" onClick={() => navigate('Arrivals')}><span className="quick-icon blue"><Boxes size={17}/></span><span><strong>Arrivals</strong><small>Review season arrivals</small></span><span className="quick-arrow">→</span></button><button className="quick-card" onClick={() => navigate('Kisans')}><span className="quick-icon sand"><Users size={17}/></span><span><strong>Find a kisan</strong><small>Search farmer directory</small></span><span className="quick-arrow">→</span></button><button className="quick-card" onClick={() => navigate('Buyers')}><span className="quick-icon lilac"><Search size={17}/></span><span><strong>Find a buyer</strong><small>Search buyer directory</small></span><span className="quick-arrow">→</span></button></div></section>
        </>}
        {active === 'Kisans' && !selectedParty && <Directory partyKind="KISAN" language={settings?.language ?? 'EN'} title="Kisans" subtitle="Open a Kisan to view their payable balance and complete transaction statement." count={kisans.length} search={search} setSearch={setSearch} rows={filteredKisans.map((row) => ({ id: row.id, name: row.name, detail: [row.mobile, row.village].filter(Boolean).join(' · '), status: row.status }))} onAdd={isAdmin ? () => { setPartyEditTarget(null); setModal('kisan') } : undefined} onEdit={isAdmin ? (id) => { const row = kisans.find((item) => item.id === id); if (row) { setPartyEditTarget(row); setModal('kisanEdit') } } : undefined} onSelect={(id) => setSelectedParty({ kind: 'KISAN', id })} />}
        {active === 'Buyers' && !selectedParty && <Directory partyKind="BUYER" language={settings?.language ?? 'EN'} title="Buyers" subtitle="Open a Buyer to view their receivable balance and complete transaction statement." count={buyers.length} search={search} setSearch={setSearch} rows={filteredBuyers.map((row) => ({ id: row.id, name: row.name, detail: row.mobile, status: row.status }))} onAdd={isAdmin ? () => { setPartyEditTarget(null); setModal('buyer') } : undefined} onEdit={isAdmin ? (id) => { const row = buyers.find((item) => item.id === id); if (row) { setPartyEditTarget(row); setModal('buyerEdit') } } : undefined} onSelect={(id) => setSelectedParty({ kind: 'BUYER', id })} />}
        {selectedParty && (active === 'Kisans' || active === 'Buyers') && <PartyStatementPage kind={selectedParty.kind} party={selectedParty.kind === 'KISAN' ? kisans.find((row) => row.id === selectedParty.id) : buyers.find((row) => row.id === selectedParty.id)} selectedSeasonId={selectedSeason} transactions={transactions.filter((row) => row.transactionStatus !== 'CANCELLED')} seasons={seasons} crops={crops} varieties={varieties} expenses={expenses} payments={selectedParty.kind === 'KISAN' ? kisanPayments : buyerPayments} seasonSummaries={partySeasonSummaries.filter((row) => row.partyType === selectedParty.kind && row.partyId === selectedParty.id)} statement={aggregatePartySeasonSummaries(selectedParty.kind, selectedParty.id, partySeasonSummaries)} onSelectSeason={(seasonId) => refresh(seasonId).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load season details from Google Drive.'))} onBack={() => setSelectedParty(null)} onPayment={() => setModal('payment')} onExpense={() => setModal('expense')} onViewSale={(row) => { setSettlementTarget(row); setModal('settlement') }} onEditPayment={(payment) => { setPaymentTarget(payment); setModal('paymentEdit') }} onVoidPayment={voidPayment} onEditExpense={(expense) => { setExpenseTarget(expense); setModal('expenseEdit') }} onVoidExpense={voidExpense} onEditSale={(row) => { setSaleTarget(row); setModal('sale') }} onUndoSale={undoSale} runAction={runButtonAction} canCorrectOps={canCorrectOps} canManageMoney={canManageMoney} isAdmin={isAdmin} />}
        {active === 'Crops & Varieties' && isAdmin && <section className="feature-page"><div className="page-heading"><div>{!hindiUi && <div className="eyebrow">MASTER DATA · {crops.length} CROPS · {varieties.length} VARIETIES</div>}<h1>{hindiUi ? 'फसलें और किस्में' : 'Crops & Varieties'}</h1><p>{hindiUi ? 'अपनी मंडी में खरीदी जाने वाली फसलों और उनकी किस्मों का प्रबंधन करें।' : 'Manage crop types and the varieties accepted at your mandi.'}</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => { setVarietyEditTarget(null); setDefaultVarietyCropId(''); setModal('variety') }} disabled={crops.length === 0}><Plus size={14}/> {hindiUi ? 'किस्म जोड़ें' : 'Add variety'}</button><button className="primary-button" onClick={() => { setCropEditTarget(null); setModal('crop') }}><Plus size={16}/> {hindiUi ? 'फसल जोड़ें' : 'Add crop'}</button></div></div><div className="table-toolbar"><label className="search-box"><Search size={16}/><input placeholder={hindiUi ? 'फसल या किस्म खोजें...' : 'Search crops or varieties...'} value={search} onChange={(event) => setSearch(event.target.value)}/></label><span>{crops.filter((crop) => `${crop.name} ${varieties.filter((variety) => variety.cropId === crop.id).map((variety) => variety.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())).length} crops shown</span></div><div className="crop-grid">{crops.filter((crop) => `${crop.name} ${varieties.filter((variety) => variety.cropId === crop.id).map((variety) => variety.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())).map((crop) => { const cropVarieties = varieties.filter((variety) => variety.cropId === crop.id); return <article className="crop-card" key={crop.id}><div className="crop-card-top"><span className="metric-icon green"><Leaf size={17}/></span><span className="status-tag active-tag">{crop.status}</span></div><h2>{crop.name}</h2><p>{hindiUi ? `${cropVarieties.length} किस्में` : `${cropVarieties.length} ${cropVarieties.length === 1 ? 'variety' : 'varieties'}`}</p><div className="variety-chips">{cropVarieties.length ? cropVarieties.map((variety) => <span className="variety-chip-edit" key={variety.id}><span>{variety.name}</span><button className="small-button" onClick={() => { setVarietyEditTarget(variety); setModal('varietyEdit') }}>{hindiUi ? 'संपादित करें' : 'Edit'}</button></span>) : <small>{hindiUi ? 'कोई किस्म नहीं जोड़ी गई' : 'No varieties added'}</small>}</div><div className="crop-card-actions"><button className="small-button" onClick={() => { setCropEditTarget(crop); setModal('cropEdit') }}>{hindiUi ? 'फसल संपादित करें' : 'Edit crop'}</button><button className="crop-add-variety" onClick={() => { setVarietyEditTarget(null); setDefaultVarietyCropId(crop.id); setModal('variety') }}>＋ {hindiUi ? `${crop.name} की किस्म जोड़ें` : `Add variety to ${crop.name}`}</button></div></article> })}{!crops.length && <div className="panel blank-slate crop-empty"><Boxes size={24}/><strong>{hindiUi ? 'कोई फसल दर्ज नहीं है' : 'No crops configured'}</strong><p>{hindiUi ? 'पहले फसलें जोड़ें, फिर उनकी किस्में जोड़ें।' : 'Add crops first, then add their varieties.'}</p></div>}{crops.length > 0 && !crops.some((crop) => `${crop.name} ${varieties.filter((variety) => variety.cropId === crop.id).map((variety) => variety.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())) && <div className="panel blank-slate crop-empty"><Search size={22}/><strong>{hindiUi ? 'कोई मेल खाती फसल या किस्म नहीं मिली' : 'No matching crops or varieties'}</strong><p>{hindiUi ? 'दूसरी खोज आज़माएँ।' : 'Try another search.'}</p></div>}</div></section>}
        {active === 'Seasons' && isAdmin && <section className="feature-page"><div className="page-heading"><div><div className="eyebrow">{hindiUi ? 'स्वचालित सीज़न' : 'AUTOMATIC SEASONS'}</div><h1>{hindiUi ? 'सीज़न' : 'Seasons'}</h1><p>{hindiUi ? 'जनवरी–जून की आवक रबी और जुलाई–दिसंबर की आवक खरीफ में आती है।' : 'Arrivals in Jan–Jun are Rabi; arrivals in Jul–Dec are Kharif.'}</p></div></div><div className="panel table-panel"><div className="table-head season-head"><span>{hindiUi ? 'सीज़न' : 'SEASON'}</span><span>{hindiUi ? 'तारीख सीमा' : 'DATE RANGE'}</span><span>{hindiUi ? 'स्थिति' : 'STATUS'}</span><span/></div>{seasons.length ? seasons.map((season) => <div className="table-row season-row" key={season.id}><strong data-label={hindiUi ? 'सीज़न' : 'Season'}>{season.name}</strong><span data-label={hindiUi ? 'तारीख सीमा' : 'Date range'}>{season.startsOn} — {season.endsOn}</span><span data-label={hindiUi ? 'स्थिति' : 'Status'} className={`status-tag ${selectedSeason === season.id ? 'active-tag' : ''}`}>{selectedSeason === season.id ? hindiUi ? 'चयनित' : 'Selected' : hindiUi ? 'उपलब्ध' : 'Available'}</span><button data-label={hindiUi ? 'कार्य' : 'Action'} className="small-button" disabled={selectedSeason === season.id} onClick={(event) => runButtonAction(() => toggleActiveSeason(season), event)}>{hindiUi ? 'चुनें' : 'Select'}</button></div>) : <div className="blank-slate"><Leaf size={23}/><strong>{hindiUi ? 'अभी कोई सीज़न नहीं' : 'No seasons yet'}</strong><p>{hindiUi ? 'पहली आवक दर्ज करने पर सीज़न अपने आप बन जाएगा।' : 'A season will appear automatically when you record the first arrival.'}</p></div>}</div></section>}
        {active === 'Arrivals' && <section className="feature-page"><div className="page-heading"><div><div className="eyebrow">{currentSeason?.name ?? (hindiUi ? 'आवक की तारीख से सीज़न तय होगा' : 'SEASON DETERMINED BY ARRIVAL DATE')}</div><h1>{hindiUi ? 'आवक' : 'Arrivals'}</h1><p>{hindiUi ? 'हर प्राप्त खेप और ट्रॉली संख्या दर्ज करें तथा बिक्री की स्थिति देखें।' : 'Track every lot received, its trolley count and sale status.'}</p></div>{canRecordOps && <button className="primary-button" onClick={() => setModal('arrival')}><Plus size={16}/> {hindiUi ? 'नई आवक' : 'New arrival'}</button>}</div><div className="report-tabs arrival-tabs" role="tablist" aria-label={hindiUi ? 'आवक की स्थिति चुनें' : 'Choose arrival status'}><button type="button" role="tab" aria-selected={arrivalTab === 'ARRIVED'} className={arrivalTab === 'ARRIVED' ? 'selected' : ''} onClick={() => setArrivalTab('ARRIVED')}>{hindiUi ? 'बिना बिकी' : 'Unsold'} ({unsoldArrivalCount})</button><button type="button" role="tab" aria-selected={arrivalTab === 'SOLD'} className={arrivalTab === 'SOLD' ? 'selected' : ''} onClick={() => setArrivalTab('SOLD')}>{hindiUi ? 'बिकी हुई' : 'Sold'} ({soldArrivalCount})</button></div><div className="table-toolbar"><label className="search-box"><Search size={16}/><input placeholder={hindiUi ? 'किसान या फसल खोजें' : 'Search farmer or crop'} value={search} onChange={(event) => setSearch(event.target.value)}/></label><span>{hindiUi ? `${displayedArrivalRows.length} रिकॉर्ड` : `${displayedArrivalRows.length} arrivals`}</span></div><div className="panel table-panel"><div className="table-head transaction-head"><span>{hindiUi ? 'आवक की तारीख' : 'ARRIVAL'}</span><span>{hindiUi ? 'किसान' : 'KISAN'}</span><span>{hindiUi ? 'फसल / किस्म' : 'CROP / VARIETY'}</span><span>{hindiUi ? 'ट्रॉलियाँ / मात्रा' : 'TROLLEYS / QTY'}</span><span>{hindiUi ? 'स्थिति / कार्य' : 'STATUS / ACTION'}</span></div>{displayedArrivalRows.length ? displayedArrivalRows.map((row) => <div className="table-row transaction-row arrival-row" key={row.id}><span>{row.arrivalDate}<small>{transactionNumberFor(row)}</small></span><strong>{kisans.find((k) => k.id === row.kisanId)?.name ?? (hindiUi ? 'अज्ञात किसान' : 'Unknown kisan')}</strong><span>{crops.find((c) => c.id === row.cropId)?.name ?? (hindiUi ? 'अज्ञात फसल' : 'Unknown crop')}{row.varietyId ? ` · ${varieties.find((v) => v.id === row.varietyId)?.name ?? ''}` : ''}</span><b>{row.transactionStatus === 'SOLD' ? <>{row.quantityValue} {row.quantityUnit}<small> ({((row.quantityKg ?? 0) / 100).toFixed(2)} Qtl)</small></> : `${row.trolleyCount} ${hindiUi ? 'ट्रॉली' : row.trolleyCount === 1 ? 'trolley' : 'trolleys'}`}</b>{row.transactionStatus === 'ARRIVED' ? <span className="row-actions">{canCorrectOps && <button className="small-button" onClick={() => { setArrivalTarget(row); setModal('arrival') }}>{hindiUi ? 'आवक संपादित करें' : 'Edit arrival'}</button>}<button className="small-button" onClick={() => { setSaleTarget(row); setModal('sale') }}>{hindiUi ? 'बिक्री दर्ज करें' : 'Record sale'}</button></span> : <button className="small-button" onClick={() => { setSettlementTarget(row); setModal('settlement') }}>{hindiUi ? 'राशि देखें' : 'View amounts'}</button>}</div>) : <div className="blank-slate"><ClipboardList size={23}/><strong>{hindiUi ? arrivalTab === 'ARRIVED' ? 'कोई बिना बिकी आवक नहीं' : 'कोई बिक्री दर्ज नहीं है' : arrivalTab === 'ARRIVED' ? 'No unsold arrivals in this season' : 'No sold transactions in this season'}</strong><p>{hindiUi ? arrivalTab === 'ARRIVED' ? 'नई आवक दर्ज करने पर वह यहाँ दिखाई देगी।' : 'दर्ज की गई बिक्री यहाँ दिखाई देगी।' : arrivalTab === 'ARRIVED' ? 'Record an arrival to see it in this list.' : 'Sold transactions will appear here.'}</p></div>}</div></section>}
        {active === 'Settings' && isAdmin && <section className="feature-page"><div className="page-heading"><div><div className="eyebrow">GOOGLE DRIVE WORKSPACE</div><h1>Settings</h1><p>Defaults used for new arrivals and sales.</p></div></div><form className="panel settings-form" onSubmit={submit(saveSettings)}><h2>Quantity, commission &amp; labour</h2><p>These defaults apply to new sales. Existing sales keep their saved rates and charges.</p><div className="settings-fields"><label className="form-field"><span>Language / भाषा</span><select name="language" defaultValue={settings?.language ?? 'EN'}><option value="HI">हिन्दी</option><option value="EN">English</option></select></label><Field label="Default bag size (kg)" name="bagSizeKg" type="number" min="0.01" step="any" required defaultValue={String(settings?.bagSizeKg ?? 50)}/><label className="form-field"><span>Default quantity unit</span><select name="defaultQuantityUnit" defaultValue={settings?.defaultQuantityUnit ?? 'QUINTAL'}><option value="KG">KG</option><option value="MANN">MANN</option><option value="QUINTAL">QUINTAL</option><option value="BAG">BAG</option></select></label><Field label="Default commission (%)" name="commissionPercent" type="number" min="0" max="100" step="any" required defaultValue={String(settings?.commissionPercent ?? 2)}/><Field label="Default labour charge per bag (₹)" name="labourChargePerBag" type="number" min="0" step="any" required defaultValue={String(settings?.labourChargePerBag ?? 0)}/></div><div className="form-note">Current conversion: 1 Bag = {settings?.bagSizeKg ?? 50} kg. Mann = 40 kg and Quintal = 100 kg. Labour is calculated per bag equivalent using the sale quantity.</div><div className="form-actions"><button type="submit" className="primary-button">Save settings</button></div><div className="settings-storage"><Cloud size={16}/><span>Settings are stored in the KisanMandi folder in your Google Drive.</span></div></form><section className="panel backup-zone"><div><h2>Google Drive backups</h2><p>{hindiUi ? 'पहले डेटा बदलाव से पहले हर दिन एक स्वचालित बैकअप बनता है और 90 दिनों तक रखा जाता है।' : 'A daily snapshot is created before the first data change and kept for 90 days.'}</p><div className="backup-status" aria-live="polite"><strong>{hindiUi ? 'अंतिम सफल बैकअप' : 'Last successful backup'}</strong>{backupStatusLoading ? <span>{hindiUi ? 'बैकअप स्थिति लोड हो रही है…' : 'Loading backup status…'}</span> : backupStatus ? <span>{new Date(backupStatus.createdAt).toLocaleString(hindiUi ? 'hi-IN' : 'en-IN')} · {backupStatus.backupType === 'MANUAL' ? (hindiUi ? 'मैनुअल' : 'Manual') : (hindiUi ? 'दैनिक' : 'Daily')} · {backupStatus.fileCount} {hindiUi ? 'फ़ाइलें' : 'files'}</span> : backupStatusError ? <span role="alert">{backupStatusError}</span> : <span>{hindiUi ? 'अभी कोई बैकअप नहीं मिला' : 'No backup found yet'}</span>}</div><p className="backup-recovery-guide">{hindiUi ? 'डेटा वापस पाने की ज़रूरत हो तो काम रोकें और व्यवस्थापक से संपर्क करें। पुनर्स्थापना अंतिम विकल्प है; वर्तमान डेटा बदलने से पहले सही बैकअप चुनें।' : 'If recovery is needed, stop editing and contact the admin. Restoring is a last resort; choose the right snapshot before changing current data.'}</p><small>{hindiUi ? 'पुराने बैकअप तभी हटते हैं जब नया बैकअप सफल हो जाए।' : 'Older backups are removed only after a new backup succeeds.'}</small></div><button type="button" className="secondary-button" onClick={(event) => runButtonAction(async () => { const name = await drive.createBackupNow(); await refreshBackupStatus(); setToast(`Backup created in Google Drive: ${name}`) }, event)}>{hindiUi ? 'अभी बैकअप लें' : 'Back up now'}</button></section><section className="panel danger-zone"><h2>Clear all data</h2><p>Delete all files and season folders inside the KisanMandi folder in Google Drive. Other Drive files are not affected.</p><button type="button" className="danger-button" disabled={clearingData} onClick={clearAllDriveData}>{clearingData ? 'Clearing Drive data…' : 'Clear all KisanMandi data'}</button></section></section>}
        {active === 'Expenses' && isAdmin && <section className="feature-page"><div className="page-heading"><div>{!hindiUi && <div className="eyebrow">ACCOUNT ENTRIES · {expenses.filter((row) => row.status === 'ACTIVE').length} ACTIVE</div>}<h1>Expenses</h1><p>{hindiUi ? 'बिक्री पर खर्च दर्ज करें और चुनें कि यह किसान, खरीदार या एजेंट के खाते को प्रभावित करेगा।' : 'Record expenses against sales and choose whether they affect a Kisan, Buyer, or the Agent.'}</p></div><button className="primary-button" onClick={() => { setExpenseTarget(null); setModal('expense') }}><Plus size={16}/> {hindiUi ? 'खर्च जोड़ें' : 'Add expense'}</button></div><div className="table-toolbar"><label className="search-box"><Search size={16}/><input placeholder={hindiUi ? 'पार्टी, फसल या विवरण खोजें' : 'Search party, crop or description'} value={search} onChange={(event) => setSearch(event.target.value)}/></label><span>{hindiUi ? '' : ''}{expenses.filter((row) => { const tx = transactions.find((item) => item.id === row.transactionId); const party = row.side === 'SELF' ? (hindiUi ? 'एजेंट (स्वयं)' : 'Agent (Self)') : row.side === 'KISAN' ? kisans.find((item) => item.id === tx?.kisanId)?.name : buyers.find((item) => item.id === tx?.buyerId)?.name; return `${party ?? ''} ${row.description} ${row.expenseType}`.toLowerCase().includes(search.toLowerCase()) }).length} records</span></div><div className="panel table-panel"><div className="table-head expense-head"><span>DATE / SEASON</span><span>PARTY / ACCOUNT</span><span>TRANSACTION</span><span>TYPE / NOTE</span><span>AMOUNT</span><span>STATUS / ACTION</span></div>{expenses.filter((row) => { const tx = transactions.find((item) => item.id === row.transactionId); const party = row.side === 'SELF' ? (hindiUi ? 'एजेंट (स्वयं)' : 'Agent (Self)') : row.side === 'KISAN' ? kisans.find((item) => item.id === tx?.kisanId)?.name : buyers.find((item) => item.id === tx?.buyerId)?.name; return `${party ?? ''} ${row.description} ${row.expenseType}`.toLowerCase().includes(search.toLowerCase()) }).sort((a,b) => b.date.localeCompare(a.date)).map((row) => { const tx = transactions.find((item) => item.id === row.transactionId); const party = row.side === 'SELF' ? (hindiUi ? 'एजेंट (स्वयं)' : 'Agent (Self)') : row.side === 'KISAN' ? kisans.find((item) => item.id === tx?.kisanId)?.name : buyers.find((item) => item.id === tx?.buyerId)?.name; return <div className={`table-row expense-row ${row.status === 'INACTIVE' ? 'voided-row' : ''}`} key={row.id}><span>{row.date}<small>{seasons.find((item) => item.id === row.seasonId)?.name ?? 'Season'}</small></span><span>{party ?? (hindiUi ? 'अज्ञात पार्टी' : 'Unknown party')} · {row.side === 'SELF' ? 'SELF' : row.side}</span><span><strong>{tx ? transactionNumberFor(tx) : '—'}</strong><small>{tx?.arrivalDate ?? 'Unknown transaction'} · {crops.find((item) => item.id === tx?.cropId)?.name ?? 'Crop'}</small></span><span>{row.expenseType.replaceAll('_',' ')}<small>{row.description || '—'}</small></span><b>{formatRupees(row.amount)}</b><span className="row-actions">{row.status === 'INACTIVE' ? <span className="status-tag">{hindiUi ? 'रद्द' : 'VOIDED'}</span> : <><button className="small-button" onClick={() => { setExpenseTarget(row); setSelectedParty(null); setModal('expenseEdit') }}>Edit</button><button className="small-button danger-button" onClick={(event) => runButtonAction(() => voidExpense(row), event)}>{hindiUi ? 'रद्द करें' : 'Void'}</button></>}</span></div> })}{!expenses.length && <div className="blank-slate"><ArrowDownToLine size={23}/><strong>No expenses recorded</strong><p>Add an expense to track its effect on a party balance.</p></div>}</div></section>}
        {active === 'Audit history' && isAdmin && <section className="feature-page"><div className="page-heading"><div><div className="eyebrow">{hindiUi ? 'परिवर्तनों का रिकॉर्ड' : 'CHANGE RECORD'}</div><h1>{hindiUi ? 'ऑडिट इतिहास' : 'Audit history'}</h1><p>{hindiUi ? 'रिकॉर्ड किसने और कब बनाया, सुधारा या रद्द किया, देखें।' : 'Review who created, corrected, or voided a record and when.'}</p></div></div><div className="table-toolbar"><label className="search-box"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={hindiUi ? 'प्रकार, रिकॉर्ड आईडी या उपयोगकर्ता खोजें' : 'Search type, record ID, or user'}/></label><span>{filteredAuditLogs.length} {hindiUi ? 'प्रविष्टियाँ' : 'entries'}</span></div><div className="audit-list">{filteredAuditLogs.length ? filteredAuditLogs.map((row) => <article className="panel audit-entry" key={row.id}><header><div><strong>{hindiUi ? ({ CREATE: 'बनाया', UPDATE: 'सुधारा', VOID: 'रद्द किया' } as const)[row.action] : row.action}</strong><span>{row.entityType} · {row.entityId}</span></div><time dateTime={row.timestamp}>{new Date(row.timestamp).toLocaleString(hindiUi ? 'hi-IN' : 'en-IN')}</time></header><p>{row.actorEmail ?? (hindiUi ? 'पुराना रिकॉर्ड' : 'Legacy record')}{row.actorProfile ? ` · ${row.actorProfile}` : ''}</p><details><summary>{hindiUi ? 'परिवर्तन देखें' : 'View changes'}</summary><pre>{JSON.stringify(row.details, null, 2)}</pre></details></article>) : <div className="panel blank-slate"><Activity size={23}/><strong>{hindiUi ? 'कोई ऑडिट प्रविष्टि नहीं' : 'No audit entries'}</strong><p>{hindiUi ? 'नए रिकॉर्ड और सुधार यहाँ दिखाई देंगे।' : 'New records and corrections will appear here.'}</p></div>}</div></section>}
        {active === 'Reports' && <ReportsPage language={settings?.language ?? 'EN'} reportKind={reportKind} setReportKind={setReportKind} reportDate={reportDate} setReportDate={setReportDate} reportEndDate={reportEndDate} setReportEndDate={setReportEndDate} seasonName={currentSeason?.name ?? 'Selected season'} seasonId={selectedSeason} seasons={seasons} onSelectSeason={(id) => refresh(id).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load season data.'))} onLoadAllSeasonTransactions={loadTransactionsForAllSeasons} transactions={transactions} kisans={kisans} buyers={buyers} crops={crops} varieties={varieties} summaries={partySeasonSummaries} />}
      </div>
    </main>
    <nav className="mobile-nav" aria-label="Main navigation">
      {visibleNavItems.filter(({ label }) => mobilePrimaryPages.includes(label)).map(({ label, icon: Icon }) => <button type="button" key={label} className={`mobile-nav-item ${active === label ? 'selected' : ''}`} aria-current={active === label ? 'page' : undefined} onClick={() => navigate(label)}><Icon size={18} strokeWidth={1.9}/><span>{label === 'Dashboard' ? 'Home' : label}</span></button>)}
      <button type="button" className={`mobile-nav-item ${mobileMoreOpen || !mobilePrimaryPages.includes(active) ? 'selected' : ''}`} aria-expanded={mobileMoreOpen} aria-haspopup="menu" onClick={() => setMobileMoreOpen((open) => !open)}><MoreHorizontal size={19}/><span>More</span></button>
    </nav>
    {mobileMoreOpen && <><button type="button" className="mobile-menu-scrim" aria-label="Close navigation menu" onClick={() => setMobileMoreOpen(false)} /><div className="mobile-more-menu" role="menu" aria-label="More pages">{mobileMoreItems.map(({ label, icon: Icon }) => <button type="button" role="menuitem" key={label} onClick={() => navigate(label)}><Icon size={17}/><span>{label}</span></button>)}{isAdmin && <button type="button" role="menuitem" onClick={() => navigate('Settings')}><Settings2 size={17}/><span>Settings</span></button>}<button type="button" role="menuitem" onClick={() => { setMobileMoreOpen(false); signOut() }}><LogOut size={17}/><span>Sign out</span></button></div></>}
    {modal && <Modal title={modal === 'sale' && saleTarget?.transactionStatus === 'SOLD' ? 'Correct sale details' : modal === 'arrival' && arrivalTarget ? 'Correct arrival details' : { kisan: 'Add a kisan', buyer: 'Add a buyer', crop: 'Add a crop', variety: 'Add a variety', arrival: 'Record an arrival', sale: 'Record sale details', settlement: 'Sale settlement', payment: 'Record payment', expense: 'Record expense', paymentEdit: 'Correct payment', expenseEdit: 'Correct expense', kisanEdit: 'Edit Kisan details', buyerEdit: 'Edit Buyer details', cropEdit: 'Edit crop', varietyEdit: 'Edit variety' }[modal]} close={() => { setModal(null); setSaleTarget(null); setArrivalTarget(null); setSettlementTarget(null); setPaymentTarget(null); setExpenseTarget(null); setPartyEditTarget(null); setCropEditTarget(null); setVarietyEditTarget(null); setError('') }} error={error} onReconnect={reconnectGoogle} reconnecting={reauthorizing}>
      {(modal === 'kisan' || modal === 'kisanEdit') && <form className="form-grid" onSubmit={submit((data) => createMaster('kisan', data))}><Field label="Full name" name="name" defaultValue={partyEditTarget?.name} required/><Field label="Mobile number" name="mobile" type="tel" inputMode="numeric" pattern="[0-9]{10,}" minLength={10} maxLength={15} title="Enter at least 10 digits (digits only)." defaultValue={partyEditTarget?.mobile} required/><Field label="Village" name="village" defaultValue={partyEditTarget && 'village' in partyEditTarget ? partyEditTarget.village : ''}/><Field label="Address" name="address" defaultValue={partyEditTarget?.address}/><div className="form-note full-field">Each Kisan must have a unique mobile number. The same number may also be used for one Buyer.</div><FormActions cancel={() => { setModal(null); setPartyEditTarget(null) }} saveLabel={modal === 'kisanEdit' ? 'Save correction' : 'Save kisan'} /></form>}
      {(modal === 'buyer' || modal === 'buyerEdit') && <form className="form-grid" onSubmit={submit((data) => createMaster('buyer', data))}><Field label="Buyer name" name="name" defaultValue={partyEditTarget?.name} required/><Field label="Mobile number" name="mobile" type="tel" inputMode="numeric" pattern="[0-9]{10,}" minLength={10} maxLength={15} title="Enter at least 10 digits (digits only)." defaultValue={partyEditTarget?.mobile} required/><Field label="Address" name="address" defaultValue={partyEditTarget?.address}/><div className="form-note full-field">Each Buyer must have a unique mobile number. The same number may also be used for one Kisan.</div><FormActions cancel={() => { setModal(null); setPartyEditTarget(null) }} saveLabel={modal === 'buyerEdit' ? 'Save correction' : 'Save buyer'} /></form>}
      {(modal === 'crop' || modal === 'cropEdit') && <form className="form-grid" onSubmit={submit(createCrop)}><Field label="Crop name" name="name" placeholder="e.g. WHEAT" defaultValue={cropEditTarget?.name} required/><div className="form-note">Crop names are stored in uppercase and can be reused across seasons.</div><FormActions cancel={() => { setModal(null); setCropEditTarget(null) }} saveLabel={modal === 'cropEdit' ? 'Save correction' : 'Save crop'} /></form>}
      {(modal === 'variety' || modal === 'varietyEdit') && <form className="form-grid" onSubmit={submit(createVariety)}>{varietyEditTarget ? <><label className="form-field"><span>Crop</span><input value={crops.find((crop) => crop.id === varietyEditTarget.cropId)?.name ?? 'Crop'} readOnly/></label><input type="hidden" name="cropId" value={varietyEditTarget.cropId}/></> : <label className="form-field"><span>Crop *</span><select name="cropId" required defaultValue={defaultVarietyCropId}><option value="" disabled>Select a crop</option>{crops.filter((crop) => crop.status === 'ACTIVE').map((crop) => <option key={crop.id} value={crop.id}>{crop.name}</option>)}</select></label>}<Field label="Variety name" name="name" placeholder="e.g. 2967" defaultValue={varietyEditTarget?.name} required/><div className="form-note">The variety will be linked to the selected crop.</div><FormActions cancel={() => { setModal(null); setVarietyEditTarget(null) }} saveLabel={modal === 'varietyEdit' ? 'Save correction' : 'Save variety'} /></form>}
      {modal === 'arrival' && <ArrivalForm kisans={kisans} crops={crops} varieties={varieties} initial={arrivalTarget ?? undefined} onSubmit={submit(createArrival)} onCancel={() => { setModal(null); setArrivalTarget(null) }} onAddKisan={() => setModal('kisan')} />}
      {modal === 'sale' && saleTarget && <form className="form-grid" onSubmit={submit(createSale)}><div className="form-note">{saleTarget.transactionStatus === 'SOLD' ? 'Correcting saved sale' : 'Arrival'}: {kisans.find((row) => row.id === saleTarget.kisanId)?.name} · {saleTarget.trolleyCount} trolley{saleTarget.trolleyCount === 1 ? '' : 's'} · {crops.find((row) => row.id === saleTarget.cropId)?.name}</div><label className="form-field"><span>Buyer *</span><select name="buyerId" required defaultValue={saleTarget.buyerId ?? ''}><option value="" disabled>Select buyer</option>{buyers.filter((row) => row.status === 'ACTIVE').map((row) => <option key={row.id} value={row.id}>{row.name} · {row.mobile}</option>)}</select></label><Field label="Sale date" name="saleDate" type="date" defaultValue={saleTarget.saleDate ?? today()} required/><Field label="Quantity" name="quantityValue" type="number" min="0.01" step="any" required defaultValue={saleTarget.quantityValue == null ? '' : String(saleTarget.quantityValue)}/><label className="form-field"><span>Quantity unit</span><select name="quantityUnit" defaultValue={saleTarget.quantityUnit ?? settings?.defaultQuantityUnit ?? 'QUINTAL'}><option value="QUINTAL">QUINTAL</option><option value="KG">KG</option><option value="MANN">MANN</option><option value="BAG">BAG</option></select></label><Field label="Price per quintal (₹)" name="pricePerQuintal" type="number" min="0.01" step="any" required defaultValue={saleTarget.pricePerQuintal == null ? '' : String(saleTarget.pricePerQuintal)}/><Field label="Commission rate (%)" name="commissionPercent" type="number" min="0" max="100" step="any" required defaultValue={String(saleTarget.commissionPercent ?? settings?.commissionPercent ?? 2)}/><Field label="Labour charge per bag (₹)" name="labourChargePerBag" type="number" min="0" step="any" required defaultValue={String(saleTarget.labourChargePerBag ?? settings?.labourChargePerBag ?? 0)}/><Field label="Buyer due date" name="buyerDueDate" type="date" defaultValue={saleTarget.buyerDueDate ?? ''}/><div className="form-note">The labour total is calculated from quantity ÷ {settings?.bagSizeKg ?? 50} kg per bag and saved with the sale.</div><FormActions cancel={() => { setModal(null); setSaleTarget(null) }} saveLabel={saleTarget.transactionStatus === 'SOLD' ? 'Save correction' : 'Save sale'} /></form>}
      {modal === 'settlement' && settlementTarget && <SettlementDetails transaction={settlementTarget} kisanName={kisans.find((row) => row.id === settlementTarget.kisanId)?.name ?? 'Kisan'} buyerName={buyers.find((row) => row.id === settlementTarget.buyerId)?.name ?? 'Buyer not selected'} onClose={() => { setModal(null); setSettlementTarget(null) }} />}
      {modal === 'payment' && selectedParty && <form className="form-grid" onSubmit={submit(createPayment)}><div className="form-note full-field">This payment is recorded on the {selectedParty.kind === 'KISAN' ? 'Kisan account' : 'Buyer account'} and applied against the total balance. Amounts are rounded to the nearest ₹10 when saved. If linked, combined payments for that sale cannot exceed its amount.</div><label className="form-field full-field"><span>Transaction (optional)</span><select name="transactionId" defaultValue=""><option value="">No specific transaction</option>{transactions.filter((row) => row.transactionStatus === 'SOLD' && (selectedParty.kind === 'KISAN' ? row.kisanId === selectedParty.id : row.buyerId === selectedParty.id)).map((row) => <option key={row.id} value={row.id}>{transactionNumberFor(row)} · {row.arrivalDate} · {crops.find((crop) => crop.id === row.cropId)?.name}</option>)}</select></label><Field label="Amount (₹)" name="amount" type="number" min="0.01" step="any" required/><Field label="Payment date" name="paymentDate" type="date" defaultValue={today()} required/><label className="form-field"><span>Payment method</span><select name="paymentMethod" defaultValue="CASH"><option>CASH</option><option>UPI</option><option>BANK</option><option>CHEQUE</option><option>OTHER</option></select></label><Field label="Reference / note" name="reference"/><FormActions cancel={() => setModal(null)} saveLabel="Save payment" /></form>}
      {modal === 'paymentEdit' && paymentTarget && <form className="form-grid" onSubmit={submit(editPayment)}><div className="form-note full-field">Correct this payment record. The original values are retained in the audit history. Amounts are rounded to the nearest ₹10 when saved. If linked, combined payments cannot exceed that sale amount.</div><label className="form-field full-field"><span>Transaction (optional)</span><select name="transactionId" defaultValue={paymentTarget.transactionId ?? ''}><option value="">No specific transaction</option>{paymentTarget.transactionId && !transactions.some((row) => row.id === paymentTarget.transactionId) && <option value={paymentTarget.transactionId}>{paymentTarget.transactionNumber ?? 'Linked transaction'} · from another season</option>}{transactions.filter((row) => row.transactionStatus === 'SOLD' && ('kisanId' in paymentTarget ? row.kisanId === paymentTarget.kisanId : row.buyerId === paymentTarget.buyerId)).map((row) => <option key={row.id} value={row.id}>{transactionNumberFor(row)} · {row.arrivalDate} · {crops.find((crop) => crop.id === row.cropId)?.name}</option>)}</select></label><Field label="Amount (₹)" name="amount" type="number" min="0.01" step="any" required defaultValue={String(paymentTarget.amount)}/><Field label="Payment date" name="paymentDate" type="date" defaultValue={paymentTarget.paymentDate} required/><label className="form-field"><span>Payment method</span><select name="paymentMethod" defaultValue={paymentTarget.paymentMethod}><option>CASH</option><option>UPI</option><option>BANK</option><option>CHEQUE</option><option>OTHER</option></select></label><Field label="Reference / note" name="reference" defaultValue={paymentTarget.reference}/><FormActions cancel={() => { setModal(null); setPaymentTarget(null) }} saveLabel="Save correction" /></form>}
      {(modal === 'expense' || modal === 'expenseEdit') && (selectedParty || active === 'Expenses') && <form className="form-grid" onSubmit={submit(createExpense)}>{!selectedParty && <label className="form-field"><span>Affects account</span><select name="side" required defaultValue={expenseTarget?.side ?? 'BUYER'}><option value="BUYER">Buyer</option><option value="KISAN">Kisan</option><option value="SELF">Self (Agent)</option></select></label>}<label className="form-field full-field"><span>Transaction *</span><select name="transactionId" required defaultValue={expenseTarget?.transactionId ?? ''}><option value="" disabled>Select transaction</option>{transactions.filter((row) => !selectedParty || (selectedParty.kind === 'KISAN' ? row.kisanId === selectedParty.id : row.buyerId === selectedParty.id)).map((row) => <option key={row.id} value={row.id}>{transactionNumberFor(row)} · {row.arrivalDate} · {crops.find((crop) => crop.id === row.cropId)?.name} · {row.transactionStatus}</option>)}</select></label><label className="form-field"><span>Expense type</span><select name="expenseType" defaultValue={expenseTarget?.expenseType ?? 'OTHER'}><option>LABOUR</option><option>TRANSPORTATION</option><option>MANDI_CHARGES</option><option>OTHER</option></select></label><Field label="Amount (₹)" name="amount" type="number" min="0.01" step="any" required defaultValue={expenseTarget ? String(expenseTarget.amount) : undefined}/><Field label="Date" name="date" type="date" defaultValue={expenseTarget?.date ?? today()} required/><Field label="Description" name="description" defaultValue={expenseTarget?.description}/><div className="form-note full-field">The expense stays linked to this transaction for reference. Kisan or Buyer expenses adjust that party’s balance; Self (Agent) expenses are recorded without changing either party’s balance.</div><FormActions cancel={() => { setModal(null); setExpenseTarget(null) }} saveLabel={expenseTarget ? 'Save correction' : 'Save expense'} /></form>}
    </Modal>}
    {toast && <div className="toast" role="status">✓ {toast}</div>}
  </div></Localize>
}

function Localize({ language, children }: { language: 'HI' | 'EN'; children: React.ReactNode }) {
  if (language !== 'HI') return <>{children}</>
  const translate = (value: string) => {
    const trimmed = value.trim()
    const translated = hi[trimmed]
    return translated ? `${value.slice(0, value.indexOf(trimmed))}${translated}${value.slice(value.indexOf(trimmed) + trimmed.length)}` : value
  }
  const walk = (node: React.ReactNode): React.ReactNode => Children.map(node, (child) => {
    if (typeof child === 'string') return translate(child)
    if (!isValidElement(child)) return child
    const props = child.props as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of ['placeholder', 'title', 'aria-label']) if (typeof props[key] === 'string') next[key] = translate(props[key] as string)
    if (child.type === 'option' && !('value' in props) && typeof props.children === 'string') next.value = props.children
    next.children = walk(props.children as React.ReactNode)
    return cloneElement(child, next)
  })
  return <>{walk(children)}</>
}

function ReportsPage({ language, reportKind, setReportKind, reportDate, setReportDate, reportEndDate, setReportEndDate, seasonName, seasonId, seasons, onSelectSeason, onLoadAllSeasonTransactions, transactions, kisans, buyers, crops, varieties, summaries }: { language: 'HI' | 'EN'; reportKind: ReportKind; setReportKind: (kind: ReportKind) => void; reportDate: string; setReportDate: (date: string) => void; reportEndDate: string; setReportEndDate: (date: string) => void; seasonName: string; seasonId: string; seasons: Season[]; onSelectSeason: (seasonId: string) => void; onLoadAllSeasonTransactions: () => Promise<Transaction[]>; transactions: Transaction[]; kisans: Kisan[]; buyers: Buyer[]; crops: Crop[]; varieties: Variety[]; summaries: PartySeasonSummary[] }) {
  const [partyId, setPartyId] = useState('')
  const [reportSeasonId, setReportSeasonId] = useState(seasonId)
  const [allSeasonTransactions, setAllSeasonTransactions] = useState<Transaction[] | null>(null)
  const [allSeasonsLoading, setAllSeasonsLoading] = useState(false)
  const [allSeasonsError, setAllSeasonsError] = useState('')
  const [reportCropId, setReportCropId] = useState('')
  const allSeasonLoadPromise = useRef<Promise<Transaction[]> | null>(null)
  useEffect(() => setReportSeasonId(seasonId), [seasonId])
  const hindi = language === 'HI'
  const isBalanceReport = reportKind === 'KISAN_BALANCES' || reportKind === 'BUYER_BALANCES'
  const allSeasonsSelected = reportSeasonId === 'ALL'
  const reportSeasonName = allSeasonsSelected ? (hindi ? 'सभी सीज़न' : 'All seasons') : (seasons.find((season) => season.id === reportSeasonId)?.name ?? seasonName)
  const ensureAllSeasonTransactions = useCallback(async () => {
    if (allSeasonTransactions !== null) return
    const pending = allSeasonLoadPromise.current ?? (allSeasonLoadPromise.current = onLoadAllSeasonTransactions())
    setAllSeasonsLoading(true)
    setAllSeasonsError('')
    try { setAllSeasonTransactions(await pending) }
    catch (reason) { setAllSeasonsError(reason instanceof Error ? reason.message : (hindi ? 'सभी सीज़न का डेटा लोड नहीं हो सका।' : 'Could not load all-season data.')) }
    finally { if (allSeasonLoadPromise.current === pending) allSeasonLoadPromise.current = null; setAllSeasonsLoading(false) }
  }, [allSeasonTransactions, hindi, onLoadAllSeasonTransactions])
  const reportNames: Record<ReportKind, string> = hindi ? { UNSOLD_ARRIVALS: 'बिना बिकी आवक', DAILY_SALE: 'वर्तमान सीज़न की दैनिक बिक्री', KISAN_BALANCES: 'किसान बकाया', BUYER_BALANCES: 'खरीदार बकाया' } : { UNSOLD_ARRIVALS: 'Unsold Arrivals', DAILY_SALE: 'Current Season Daily Sale', KISAN_BALANCES: 'Kisan Balances', BUYER_BALANCES: 'Buyer Balances' }
  const unsoldRows = transactions.filter((row) => row.seasonId === seasonId && row.transactionStatus === 'ARRIVED' && row.arrivalDate >= reportDate && row.arrivalDate <= reportEndDate && (!reportCropId || row.cropId === reportCropId)).sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate) || transactionNumberFor(a).localeCompare(transactionNumberFor(b)))
  const saleRows = transactions.filter((row) => row.seasonId === seasonId && row.transactionStatus === 'SOLD' && (row.saleDate ?? '') >= reportDate && (row.saleDate ?? '') <= reportEndDate && (!reportCropId || row.cropId === reportCropId)).sort((a, b) => (a.saleDate ?? '').localeCompare(b.saleDate ?? '') || transactionNumberFor(a).localeCompare(transactionNumberFor(b)))
  const selectedSeasonSummaries = summaries.filter((row) => allSeasonsSelected || row.seasonId === reportSeasonId)
  const availableParties = reportKind === 'KISAN_BALANCES' ? kisans : buyers
  const activePartyId = availableParties.some((party) => party.id === partyId) ? partyId : ''
  useEffect(() => {
    if (allSeasonsSelected && activePartyId && !allSeasonTransactions && !allSeasonsError) void ensureAllSeasonTransactions()
  }, [allSeasonsSelected, activePartyId, allSeasonTransactions, allSeasonsError, ensureAllSeasonTransactions])
  const kisanRows = kisans.filter((party) => !activePartyId || party.id === activePartyId).map((party) => ({ party, statement: aggregatePartySeasonSummaries('KISAN', party.id, selectedSeasonSummaries) })).sort((a, b) => b.statement.outstanding - a.statement.outstanding)
  const buyerRows = buyers.filter((party) => !activePartyId || party.id === activePartyId).map((party) => ({ party, statement: aggregatePartySeasonSummaries('BUYER', party.id, selectedSeasonSummaries) })).sort((a, b) => b.statement.outstanding - a.statement.outstanding)
  const transactionSource = allSeasonsSelected ? (allSeasonTransactions ?? []) : transactions
  const partyTransactions = transactionSource.filter((row) => (allSeasonsSelected || row.seasonId === reportSeasonId) && row.transactionStatus === 'SOLD' && (reportKind === 'KISAN_BALANCES' ? row.kisanId === activePartyId : row.buyerId === activePartyId)).sort((a, b) => (a.saleDate ?? '').localeCompare(b.saleDate ?? '') || transactionNumberFor(a).localeCompare(transactionNumberFor(b)))
  const saleSettlements = saleRows.map((row) => ({ row, settlement: calculateSaleSettlement(row) })).filter((entry): entry is { row: Transaction; settlement: NonNullable<ReturnType<typeof calculateSaleSettlement>> } => entry.settlement !== null)
  const qtl = (kg: number) => (kg / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const dateLabel = new Date(`${reportDate}T00:00:00`).toLocaleDateString(hindi ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
  const endDateLabel = new Date(`${reportEndDate}T00:00:00`).toLocaleDateString(hindi ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
  const dateRangeLabel = reportDate === reportEndDate ? dateLabel : `${dateLabel} – ${endDateLabel}`
  const totalSalesValue = saleSettlements.reduce((sum, entry) => sum + entry.settlement.grossSale, 0)
  const totalCommission = saleSettlements.reduce((sum, entry) => sum + entry.settlement.commission, 0)
  const totalLabour = saleSettlements.reduce((sum, entry) => sum + entry.settlement.labourCharge, 0)
  const totalQuantityKg = saleRows.reduce((sum, row) => sum + (row.quantityKg ?? 0), 0)
  const kisanTotals = kisanRows.reduce((total, entry) => ({ sales: total.sales + entry.statement.grossSales, commission: total.commission + entry.statement.commission, labour: total.labour + entry.statement.labourCharge, expenses: total.expenses + entry.statement.expenses, payable: total.payable + entry.statement.payableOrReceivable, payments: total.payments + entry.statement.payments, balance: total.balance + entry.statement.outstanding }), { sales: 0, commission: 0, labour: 0, expenses: 0, payable: 0, payments: 0, balance: 0 })
  const buyerTotals = buyerRows.reduce((total, entry) => ({ sales: total.sales + entry.statement.grossSales, expenses: total.expenses + entry.statement.expenses, receivable: total.receivable + entry.statement.payableOrReceivable, payments: total.payments + entry.statement.payments, balance: total.balance + entry.statement.outstanding }), { sales: 0, expenses: 0, receivable: 0, payments: 0, balance: 0 })
  const cropLabel = (row: Transaction) => `${crops.find((crop) => crop.id === row.cropId)?.name ?? 'Crop'}${row.varietyId ? ` · ${varieties.find((item) => item.id === row.varietyId)?.name ?? ''}` : ''}`
  const metrics = reportKind === 'UNSOLD_ARRIVALS' ? [
    ['UNSOLD LOTS', String(unsoldRows.length)], ['TROLLEYS WAITING', String(unsoldRows.reduce((sum, row) => sum + row.trolleyCount, 0))], ['KISANS', String(new Set(unsoldRows.map((row) => row.kisanId)).size)],
  ] : reportKind === 'DAILY_SALE' ? [
    ['SALES', String(saleRows.length)], ['QUANTITY SOLD', `${qtl(totalQuantityKg)} Qtl`], ['SALES VALUE', formatRupees(totalSalesValue)], ['COMMISSION', formatRupees(totalCommission)], ['LABOUR', formatRupees(totalLabour)],
  ] : reportKind === 'KISAN_BALANCES' ? [
    ['KISANS', String(kisanRows.length)], ['TOTAL PAYABLE', formatRupees(kisanTotals.payable)], ['PAYMENTS MADE', formatRupees(kisanTotals.payments)], ['BALANCE TO PAY', formatRupees(kisanTotals.balance)],
  ] : [
    ['BUYERS', String(buyerRows.length)], ['TOTAL RECEIVABLE', formatRupees(buyerTotals.receivable)], ['PAYMENTS RECEIVED', formatRupees(buyerTotals.payments)], ['BALANCE TO RECEIVE', formatRupees(buyerTotals.balance)],
  ]
  const reportSubtitle = isBalanceReport ? (hindi ? `${reportSeasonName} का कुल · सीज़न सारांश से गणना` : `${reportSeasonName} totals · Calculated from season summaries`) : `${seasonName} · ${dateRangeLabel}${reportCropId ? ` · ${crops.find((crop) => crop.id === reportCropId)?.name ?? ''}` : ''}`
  const exportReportCsv = () => {
    let rows: (string | number)[][] = []
    if (reportKind === 'UNSOLD_ARRIVALS') rows = [['Arrival date', 'Transaction no.', 'Kisan', 'Mobile', 'Crop', 'Variety', 'Trolleys', 'Season'], ...unsoldRows.map((row) => [row.arrivalDate, transactionNumberFor(row), kisans.find((item) => item.id === row.kisanId)?.name ?? '', kisans.find((item) => item.id === row.kisanId)?.mobile ?? '', crops.find((item) => item.id === row.cropId)?.name ?? '', varieties.find((item) => item.id === row.varietyId)?.name ?? '', row.trolleyCount, seasonName])]
    else if (reportKind === 'DAILY_SALE') rows = [['Sale date', 'Transaction no.', 'Kisan', 'Buyer', 'Crop', 'Variety', 'Quantity', 'Unit', 'Quantity (Qtl)', 'Price / Qtl', 'Sales value', 'Commission', 'Labour', 'Kisan payable', 'Buyer receivable'], ...saleSettlements.map(({ row, settlement }) => [row.saleDate ?? '', transactionNumberFor(row), kisans.find((item) => item.id === row.kisanId)?.name ?? '', buyers.find((item) => item.id === row.buyerId)?.name ?? '', crops.find((item) => item.id === row.cropId)?.name ?? '', varieties.find((item) => item.id === row.varietyId)?.name ?? '', row.quantityValue ?? 0, row.quantityUnit ?? '', (row.quantityKg ?? 0) / 100, row.pricePerQuintal ?? 0, settlement.grossSale, settlement.commission, settlement.labourCharge, settlement.kisanPayable, settlement.buyerReceivable])]
    else if (reportKind === 'KISAN_BALANCES') rows = [['Kisan', 'Mobile', 'Sales value', 'Commission', 'Labour', 'Expenses', 'Total payable', 'Payments made', 'Balance to pay'], ...kisanRows.map(({ party, statement }) => [party.name, party.mobile, statement.grossSales, statement.commission, statement.labourCharge, statement.expenses, statement.payableOrReceivable, statement.payments, statement.outstanding])]
    else rows = [['Buyer', 'Mobile', 'Sales value', 'Expenses', 'Total receivable', 'Payments received', 'Balance to receive'], ...buyerRows.map(({ party, statement }) => [party.name, party.mobile, statement.grossSales, statement.expenses, statement.payableOrReceivable, statement.payments, statement.outstanding])]
    downloadCsv(`kisanmandi-${reportKind.toLowerCase()}-${reportDate}-to-${reportEndDate}.csv`, rows)
  }
  const exportPartyTransactionsCsv = () => {
    const partyName = availableParties.find((party) => party.id === activePartyId)?.name ?? 'party'
    const rows: (string | number)[][] = [['Sale date', 'Transaction no.', 'Season', 'Crop', 'Variety', 'Quantity', 'Unit', 'Quantity (Qtl)', 'Price / Qtl', 'Sales value', 'Commission', 'Labour', 'Kisan payable', 'Buyer receivable'], ...partyTransactions.map((row) => { const settlement = calculateSaleSettlement(row); return [row.saleDate ?? '', transactionNumberFor(row), seasons.find((season) => season.id === row.seasonId)?.name ?? '', crops.find((item) => item.id === row.cropId)?.name ?? '', varieties.find((item) => item.id === row.varietyId)?.name ?? '', row.quantityValue ?? 0, row.quantityUnit ?? '', (row.quantityKg ?? 0) / 100, row.pricePerQuintal ?? 0, settlement?.grossSale ?? 0, settlement?.commission ?? 0, settlement?.labourCharge ?? 0, settlement?.kisanPayable ?? 0, settlement?.buyerReceivable ?? 0] })]
    downloadCsv(`kisanmandi-${reportKind.toLowerCase()}-${partyName.replace(/[^a-z0-9]+/gi, '-')}.csv`, rows)
  }

  return <Localize language={language}><section className="feature-page print-report-area">
    <div className="page-heading report-heading"><div><div className="eyebrow">{hindi ? 'रिपोर्ट' : 'REPORTS'} · {(isBalanceReport ? reportSeasonName : seasonName).toUpperCase()}</div><h1>{hindi ? 'रिपोर्ट' : 'Reports'}</h1><p>{hindi ? 'मंडी के रिकॉर्ड से संचालन और बकाया रिपोर्ट देखें।' : 'Operational and balance reports from your mandi records.'}</p></div><div className="report-heading-actions report-print-hide"><button className="secondary-button" onClick={exportReportCsv}><Download size={15}/>{hindi ? 'CSV डाउनलोड' : 'Export CSV'}</button><button className="primary-button" onClick={() => window.print()}><ClipboardList size={15}/> {hindi ? 'रिपोर्ट प्रिंट करें' : 'Print report'}</button></div></div>
    <div className="report-controls report-print-hide"><div className="report-tabs" role="tablist" aria-label={hindi ? 'रिपोर्ट चुनें' : 'Choose report'}>{(Object.keys(reportNames) as ReportKind[]).map((kind) => <button type="button" role="tab" aria-selected={reportKind === kind} className={reportKind === kind ? 'selected' : ''} key={kind} onClick={() => setReportKind(kind)}>{reportNames[kind]}</button>)}</div>{(reportKind === 'UNSOLD_ARRIVALS' || reportKind === 'DAILY_SALE') && <div className="report-filters report-range-filters"><label className="report-date-field">{hindi ? 'से' : 'From'} <input type="date" required value={reportDate} max={reportEndDate} onChange={(event) => setReportDate(event.target.value)}/></label><label className="report-date-field">{hindi ? 'तक' : 'To'} <input type="date" required value={reportEndDate} min={reportDate} onChange={(event) => setReportEndDate(event.target.value)}/></label><label className="report-date-field">{hindi ? 'फसल' : 'Crop'} <select value={reportCropId} onChange={(event) => setReportCropId(event.target.value)}><option value="">{hindi ? 'सभी फसलें' : 'All crops'}</option>{crops.map((crop) => <option value={crop.id} key={crop.id}>{crop.name}</option>)}</select></label></div>}{isBalanceReport && <div className="report-filters"><label className="report-date-field">{hindi ? 'सीज़न' : 'Season'} <select value={reportSeasonId} onChange={(event) => { const value = event.target.value; setReportSeasonId(value); setAllSeasonsError(''); if (value !== 'ALL') onSelectSeason(value) }}><option value="ALL">{hindi ? 'सभी सीज़न' : 'All seasons'}</option>{seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label><label className="report-date-field">{hindi ? (reportKind === 'KISAN_BALANCES' ? 'किसान' : 'खरीदार') : (reportKind === 'KISAN_BALANCES' ? 'Kisan' : 'Buyer')} <select value={activePartyId} onChange={(event) => { setPartyId(event.target.value); setAllSeasonsError('') }}><option value="">{hindi ? 'सभी' : 'All'}</option>{availableParties.map((party) => <option key={party.id} value={party.id}>{party.name} · {party.mobile}</option>)}</select></label></div>}</div>
    <div className="report-paper"><header className="report-paper-heading"><div className="eyebrow">KISAN MANDI · {(isBalanceReport ? reportSeasonName : seasonName).toUpperCase()}</div><h2>{reportNames[reportKind]}</h2><p>{reportSubtitle}</p><small>{hindi ? 'बनाई गई' : 'Generated'} {new Date().toLocaleString(hindi ? 'hi-IN' : 'en-IN')}</small></header>
      <div className="report-metrics">{metrics.map(([label, value]) => <article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
      {reportKind === 'UNSOLD_ARRIVALS' && <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Arrival date</th><th>Transaction no.</th><th>Kisan</th><th>Mobile</th><th>Crop / variety</th><th>Trolleys</th></tr></thead><tbody>{unsoldRows.map((row) => <tr key={row.id}><td>{row.arrivalDate}</td><td>{transactionNumberFor(row)}</td><td>{kisans.find((item) => item.id === row.kisanId)?.name ?? 'Unknown Kisan'}</td><td>{kisans.find((item) => item.id === row.kisanId)?.mobile ?? '—'}</td><td>{cropLabel(row)}</td><td>{row.trolleyCount}</td></tr>)}{!unsoldRows.length && <tr><td colSpan={6} className="report-empty">No unsold arrivals in {seasonName}.</td></tr>}</tbody><tfoot><tr><th colSpan={5}>Total trolleys waiting</th><th>{unsoldRows.reduce((sum, row) => sum + row.trolleyCount, 0)}</th></tr></tfoot></table></div>}
      {reportKind === 'DAILY_SALE' && <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Transaction</th><th>Kisan</th><th>Buyer</th><th>Crop / variety</th><th>Quantity</th><th>Rate / Qtl</th><th>Sales value</th><th>Commission</th><th>Labour</th><th>Kisan payable</th><th>Buyer receivable</th></tr></thead><tbody>{saleSettlements.map(({ row, settlement }) => <tr key={row.id}><td>{transactionNumberFor(row)}</td><td>{kisans.find((item) => item.id === row.kisanId)?.name ?? 'Kisan'}</td><td>{buyers.find((item) => item.id === row.buyerId)?.name ?? 'Buyer'}</td><td>{cropLabel(row)}</td><td>{row.quantityValue} {row.quantityUnit} <small>({qtl(row.quantityKg ?? 0)} Qtl)</small></td><td>{formatRupees(row.pricePerQuintal ?? 0)}</td><td>{formatRupees(settlement.grossSale)}</td><td>{formatRupees(settlement.commission)}</td><td>{formatRupees(settlement.labourCharge)}</td><td>{formatRupees(settlement.kisanPayable)}</td><td>{formatRupees(settlement.buyerReceivable)}</td></tr>)}{!saleSettlements.length && <tr><td colSpan={11} className="report-empty">No sales recorded for {dateLabel} in {seasonName}.</td></tr>}</tbody><tfoot><tr><th colSpan={4}>Daily total</th><th>{qtl(totalQuantityKg)} Qtl</th><th>—</th><th>{formatRupees(totalSalesValue)}</th><th>{formatRupees(totalCommission)}</th><th>{formatRupees(totalLabour)}</th><th>{formatRupees(saleSettlements.reduce((sum, entry) => sum + entry.settlement.kisanPayable, 0))}</th><th>{formatRupees(saleSettlements.reduce((sum, entry) => sum + entry.settlement.buyerReceivable, 0))}</th></tr></tfoot></table></div>}
      {reportKind === 'KISAN_BALANCES' && <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Kisan</th><th>Mobile</th><th>Sales value</th><th>Commission</th><th>Labour</th><th>Expenses</th><th>Total payable</th><th>Payments made</th><th>Balance to pay</th></tr></thead><tbody>{kisanRows.map(({ party, statement }) => <tr key={party.id}><td><button type="button" className="report-party-link" onClick={() => setPartyId(party.id)}>{party.name}</button></td><td>{party.mobile}</td><td>{formatRupees(statement.grossSales)}</td><td>{formatRupees(statement.commission)}</td><td>{formatRupees(statement.labourCharge)}</td><td>{formatRupees(statement.expenses)}</td><td>{formatRupees(statement.payableOrReceivable)}</td><td>{formatRupees(statement.payments)}</td><td>{formatRupees(statement.outstanding)}</td></tr>)}{!kisanRows.length && <tr><td colSpan={9} className="report-empty">No Kisans to report.</td></tr>}</tbody><tfoot><tr><th colSpan={2}>Total</th><th>{formatRupees(kisanTotals.sales)}</th><th>{formatRupees(kisanTotals.commission)}</th><th>{formatRupees(kisanTotals.labour)}</th><th>{formatRupees(kisanTotals.expenses)}</th><th>{formatRupees(kisanTotals.payable)}</th><th>{formatRupees(kisanTotals.payments)}</th><th>{formatRupees(kisanTotals.balance)}</th></tr></tfoot></table></div>}
      {reportKind === 'BUYER_BALANCES' && <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Buyer</th><th>Mobile</th><th>Sales value</th><th>Expenses</th><th>Total receivable</th><th>Payments received</th><th>Balance to receive</th></tr></thead><tbody>{buyerRows.map(({ party, statement }) => <tr key={party.id}><td><button type="button" className="report-party-link" onClick={() => setPartyId(party.id)}>{party.name}</button></td><td>{party.mobile}</td><td>{formatRupees(statement.grossSales)}</td><td>{formatRupees(statement.expenses)}</td><td>{formatRupees(statement.payableOrReceivable)}</td><td>{formatRupees(statement.payments)}</td><td>{formatRupees(statement.outstanding)}</td></tr>)}{!buyerRows.length && <tr><td colSpan={7} className="report-empty">No Buyers to report.</td></tr>}</tbody><tfoot><tr><th colSpan={2}>Total</th><th>{formatRupees(buyerTotals.sales)}</th><th>{formatRupees(buyerTotals.expenses)}</th><th>{formatRupees(buyerTotals.receivable)}</th><th>{formatRupees(buyerTotals.payments)}</th><th>{formatRupees(buyerTotals.balance)}</th></tr></tfoot></table></div>}
      {isBalanceReport && activePartyId && <section className="report-party-details"><header><div><h3>{hindi ? 'बिक्री लेन-देन विवरण' : 'Sold transaction details'}</h3><p>{availableParties.find((party) => party.id === activePartyId)?.name} · {reportSeasonName} · {allSeasonsLoading ? (hindi ? 'लोड हो रहा है…' : 'Loading…') : `${partyTransactions.length} ${hindi ? 'लेन-देन' : 'transactions'}`}</p></div>{(!allSeasonsSelected || allSeasonTransactions !== null) && <button type="button" className="secondary-button report-print-hide" onClick={exportPartyTransactionsCsv}><Download size={14}/>{hindi ? 'लेन-देन CSV' : 'Export transactions CSV'}</button>}</header><div className="report-table-wrap"><table className="report-table"><thead><tr><th>{hindi ? 'बिक्री तारीख' : 'Sale date'}</th><th>{hindi ? 'लेन-देन क्रमांक' : 'Transaction no.'}</th>{allSeasonsSelected && <th>{hindi ? 'सीज़न' : 'Season'}</th>}<th>{hindi ? 'फसल / किस्म' : 'Crop / variety'}</th><th>{hindi ? 'मात्रा' : 'Quantity'}</th><th>{hindi ? 'दर / क्विंटल' : 'Price / Qtl'}</th><th>{hindi ? 'बिक्री राशि' : 'Sale value'}</th><th>{hindi ? 'कमीशन' : 'Commission'}</th><th>{hindi ? 'मजदूरी' : 'Labour'}</th><th>{hindi ? 'किसान को देय' : 'Kisan payable'}</th><th>{hindi ? 'खरीदार से प्राप्ति' : 'Buyer receivable'}</th></tr></thead><tbody>{partyTransactions.map((row) => { const settlement = calculateSaleSettlement(row); return <tr key={row.id}><td>{row.saleDate}</td><td>{transactionNumberFor(row)}</td>{allSeasonsSelected && <td>{seasons.find((season) => season.id === row.seasonId)?.name ?? '—'}</td>}<td>{cropLabel(row)}</td><td>{row.quantityValue} {row.quantityUnit} <small>({qtl(row.quantityKg ?? 0)} Qtl)</small></td><td>{formatRupees(row.pricePerQuintal ?? 0)}</td><td>{formatRupees(settlement?.grossSale ?? 0)}</td><td>{formatRupees(settlement?.commission ?? 0)}</td><td>{formatRupees(settlement?.labourCharge ?? 0)}</td><td>{formatRupees(settlement?.kisanPayable ?? 0)}</td><td>{formatRupees(settlement?.buyerReceivable ?? 0)}</td></tr>})}{!partyTransactions.length && <tr><td colSpan={allSeasonsSelected ? 11 : 10} className="report-empty">{allSeasonsLoading ? (hindi ? 'सभी सीज़न की बिक्री लोड हो रही है…' : 'Loading sales from all seasons…') : allSeasonsError ? <>{allSeasonsError} <button type="button" className="small-button" onClick={() => setAllSeasonsError('')}>{hindi ? 'पुनः प्रयास करें' : 'Retry'}</button></> : hindi ? `इस पार्टी के लिए ${reportSeasonName} में कोई बिक्री दर्ज नहीं है।` : `No sold transactions for this party in ${reportSeasonName}.`}</td></tr>}</tbody></table></div></section>}
      <footer className="report-footer">{hindi ? 'किसानमंडी' : 'KisanMandi'} · {reportNames[reportKind]} · {reportSubtitle}</footer>
    </div>
  </section></Localize>
}

function Directory({ title, subtitle, count, search, setSearch, rows, onAdd, onSelect, onEdit, language, partyKind }: { partyKind: 'KISAN' | 'BUYER'; title: string; subtitle: string; count: number; search: string; setSearch: (value: string) => void; rows: { id: string; name: string; detail: string; status: string }[]; onAdd?: () => void; onSelect: (id: string) => void; onEdit?: (id: string) => void; language: 'HI' | 'EN' }) {
  const hindi = language === 'HI'
  return <section className="feature-page"><div className="page-heading"><div>{!hindi && <div className="eyebrow">MASTER DATA · {count} RECORDS</div>}<h1>{title}</h1><p>{hindi ? partyKind === 'KISAN' ? 'किसान का देय शेष और पूरा लेन-देन विवरण देखने के लिए किसान चुनें।' : 'खरीदार का बकाया और पूरा लेन-देन विवरण देखने के लिए खरीदार चुनें।' : subtitle}</p></div>{onAdd && <button className="primary-button" onClick={onAdd}><Plus size={16}/> {hindi ? partyKind === 'KISAN' ? 'किसान जोड़ें' : 'खरीदार जोड़ें' : `Add ${title === 'Kisans' ? 'kisan' : 'buyer'}`}</button>}</div><div className="table-toolbar"><label className="search-box"><Search size={16}/><input placeholder={hindi ? partyKind === 'KISAN' ? 'किसान खोजें...' : 'खरीदार खोजें...' : `Search ${title.toLowerCase()}...`} value={search} onChange={(event) => setSearch(event.target.value)}/><kbd>⌘ K</kbd></label><span>{hindi ? `${rows.length} दिखाए गए` : `${rows.length} shown`}</span></div><div className="panel table-panel"><div className="table-head directory-head"><span>{hindi ? 'नाम' : 'NAME'}</span><span>{hindi ? 'संपर्क' : 'CONTACT'}</span><span>{hindi ? 'स्थिति' : 'STATUS'}</span><span>{hindi ? 'कार्य' : 'ACTION'}</span></div>{rows.length ? rows.map((row) => <div className="table-row directory-row" key={row.id}><button className="party-link" onClick={() => onSelect(row.id)}>{row.name}<span>{hindi ? 'विवरण देखें →' : 'View statement →'}</span></button><span>{row.detail || '—'}</span><span className="status-tag active-tag">{hindi && row.status === 'ACTIVE' ? 'सक्रिय' : row.status}</span><span>{onEdit && <button className="small-button" onClick={() => onEdit(row.id)}>{hindi ? 'संपादित करें' : 'Edit'}</button>}</span></div>) : <div className="blank-slate"><Users size={23}/><strong>{hindi ? search ? 'कोई रिकॉर्ड नहीं मिला' : `${partyKind === 'KISAN' ? 'कोई किसान' : 'कोई खरीदार'} अभी नहीं है` : search ? 'No matching records' : `No ${title.toLowerCase()} yet`}</strong><p>{hindi ? search ? 'दूसरा नाम या मोबाइल नंबर खोजें।' : 'शुरू करने के लिए ऊपर जोड़ें बटन का उपयोग करें।' : search ? 'Try another name, mobile number, or village.' : 'Use the Add button above to get started.'}</p></div>}</div></section>
}

function PartyStatementPage({ kind, party, selectedSeasonId, transactions, seasons, crops, varieties, expenses, payments, seasonSummaries, statement, onSelectSeason, onBack, onPayment, onExpense, onViewSale, onEditPayment, onVoidPayment, onEditExpense, onVoidExpense, onEditSale, onUndoSale, runAction, canCorrectOps, canManageMoney, isAdmin }: { kind: 'KISAN' | 'BUYER'; party: Kisan | Buyer | undefined; selectedSeasonId: string; transactions: Transaction[]; seasons: Season[]; crops: Crop[]; varieties: Variety[]; expenses: Expense[]; payments: (KisanPayment | BuyerPayment)[]; seasonSummaries: PartySeasonSummary[]; statement: ReturnType<typeof aggregatePartySeasonSummaries>; onSelectSeason: (seasonId: string) => void; onBack: () => void; onPayment: () => void; onExpense: () => void; onViewSale: (row: Transaction) => void; onEditPayment: (payment: KisanPayment | BuyerPayment) => void; onVoidPayment: (payment: KisanPayment | BuyerPayment) => Promise<void>; onEditExpense: (expense: Expense) => void; onVoidExpense: (expense: Expense) => Promise<void>; onEditSale: (row: Transaction) => void; onUndoSale: (row: Transaction) => Promise<void>; runAction: (action: () => Promise<void>, event: React.MouseEvent<HTMLButtonElement>) => Promise<void>; canCorrectOps: boolean; canManageMoney: boolean; isAdmin: boolean }) {
  const partyTransactions = transactions.filter((row) => kind === 'KISAN' ? row.kisanId === party?.id : row.buyerId === party?.id).sort((a, b) => (b.saleDate ?? b.arrivalDate).localeCompare(a.saleDate ?? a.arrivalDate))
  const partyIds = new Set(partyTransactions.map((row) => row.id))
  const partyExpenseHistory = expenses.filter((row) => partyIds.has(row.transactionId) && row.side === kind)
  const partyExpenses = partyExpenseHistory.filter((row) => row.status === 'ACTIVE')
  const partyPayments = payments.filter((row) => kind === 'KISAN' ? 'kisanId' in row && row.kisanId === party?.id : 'buyerId' in row && row.buyerId === party?.id)
  return <section className="feature-page">
    <button className="back-link" onClick={onBack}>← Back to {kind === 'KISAN' ? 'Kisans' : 'Buyers'}</button>
    <div className="page-heading party-heading"><div><div className="eyebrow">{kind === 'KISAN' ? 'KISAN STATEMENT' : 'BUYER STATEMENT'}</div><h1>{party?.name ?? 'Party'}</h1><p>{party && 'village' in party ? [party.mobile, party.village].filter(Boolean).join(' · ') : party?.mobile}</p></div><div className="heading-actions">{kind === 'BUYER' && isAdmin && <button className="secondary-button" onClick={onExpense}><Plus size={14}/> Add expense</button>}{canManageMoney && <button className="primary-button" onClick={onPayment}><Plus size={14}/>{kind === 'KISAN' ? 'Add payment made' : 'Add payment received'}</button>}</div></div>
    <div className={`statement-summary ${kind === 'KISAN' ? 'kisan-summary' : 'buyer-summary'}`}><article><small>SALES VALUE</small><strong>{formatRupees(statement.grossSales)}</strong></article>{kind === 'KISAN' && <><article><small>COMMISSION</small><strong>{formatRupees(statement.commission)}</strong></article><article><small>LABOUR CHARGES</small><strong>{formatRupees(statement.labourCharge)}</strong></article></>}<article><small>{kind === 'KISAN' ? 'TOTAL PAYABLE' : 'TOTAL RECEIVABLE'}</small><strong>{formatRupees(statement.payableOrReceivable)}</strong></article><article><small>PAYMENTS {kind === 'KISAN' ? 'MADE' : 'RECEIVED'}</small><strong>{formatRupees(statement.payments)}</strong></article><article className="outstanding-card"><small>{kind === 'KISAN' ? 'BALANCE TO PAY' : 'BALANCE TO RECEIVE'}</small><strong>{formatRupees(statement.outstanding)}</strong></article></div>
    <div className="statement-section-title"><div><h2>Season balances</h2><p>Lifetime totals above combine all seasons. Click a season to load its detailed records.</p></div></div>
    <div className="panel table-panel season-balance-list"><div className="table-head"><span>SEASON</span><span>{kind === 'KISAN' ? 'PAYABLE' : 'RECEIVABLE'}</span><span>PAYMENTS</span><span>BALANCE</span></div>{seasonSummaries.length ? [...seasonSummaries].sort((a, b) => (seasons.find((season) => season.id === b.seasonId)?.startsOn ?? '').localeCompare(seasons.find((season) => season.id === a.seasonId)?.startsOn ?? '')).map((summary) => <button type="button" className={`table-row season-balance-row ${selectedSeasonId === summary.seasonId ? 'selected-season-balance' : ''}`} aria-pressed={selectedSeasonId === summary.seasonId} onClick={() => onSelectSeason(summary.seasonId)} key={summary.id}><strong>{seasons.find((season) => season.id === summary.seasonId)?.name ?? 'Season'}</strong><span>{formatRupees(summary.payableOrReceivable)}</span><span>{formatRupees(summary.payments)}</span><b>{formatRupees(summary.outstanding)}</b></button>) : <div className="blank-slate"><ClipboardList size={20}/><strong>No season balances yet</strong><p>Sales and payments will be summarized here by season.</p></div>}</div>
    <div className="statement-section-title"><div><h2>Transaction history</h2><p>{seasons.find((season) => season.id === selectedSeasonId)?.name ?? 'Selected season'} · {partyTransactions.length} transaction{partyTransactions.length === 1 ? '' : 's'}</p></div></div>
    <div className="panel table-panel statement-table"><div className={`table-head statement-head ${kind === 'KISAN' ? 'kisan-statement-head' : ''}`}>{kind === 'KISAN' ? <><span>DATE / SEASON</span><span>CROP</span><span>QUANTITY (QTL)</span><span>PRICE / QTL</span><span>COMMISSION</span><span>LABOUR</span><span>LIABLE TO PAY</span><span/></> : <><span>DATE / SEASON</span><span>CROP</span><span>SALE VALUE</span><span>EXPENSES</span><span>LIABLE TO RECEIVE</span><span/></>}</div>
      {partyTransactions.length ? partyTransactions.map((row) => { const sale = calculateSaleSettlement(row); const rowExpenses = partyExpenses.filter((expense) => expense.transactionId === row.id).reduce((sum, expense) => sum + expense.amount, 0); const due = sale ? (kind === 'KISAN' ? sale.kisanPayable - rowExpenses : sale.buyerReceivable + rowExpenses) : 0; const seasonName = seasons.find((season) => season.id === row.seasonId)?.name ?? 'Season'; return <div className={`table-row statement-row ${kind === 'KISAN' ? 'kisan-statement-row' : ''}`} key={row.id}><span data-label="Date / season">{row.saleDate ?? row.arrivalDate}<small>{transactionNumberFor(row)} · {seasonName} · {sale ? row.transactionStatus : `${row.transactionStatus} · INCOMPLETE`}</small></span><span data-label="Crop">{crops.find((crop) => crop.id === row.cropId)?.name ?? 'Crop'}{row.varietyId && <small>{varieties.find((item) => item.id === row.varietyId)?.name}</small>}</span>{kind === 'KISAN' ? <><span data-label="Quantity (Qtl)">{sale ? ((row.quantityKg ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</span><span data-label="Price / Qtl">{sale ? formatRupees(row.pricePerQuintal ?? 0) : '—'}</span><span data-label="Commission">{sale ? formatRupees(sale.commission) : '—'}</span><span data-label="Labour">{sale ? formatRupees(sale.labourCharge) : '—'}</span><b data-label="Liable to pay">{sale ? formatRupees(due) : '—'}</b></> : <><b data-label="Sale value">{sale ? formatRupees(sale.grossSale) : '—'}</b><span data-label="Expenses">{formatRupees(rowExpenses)}</span><b data-label="Liable to receive">{sale ? formatRupees(due) : '—'}</b></>}<span className="statement-actions" data-label="Actions">{sale && <button className="small-button" onClick={() => onViewSale(row)}>Details</button>}{row.transactionStatus === 'SOLD' && canCorrectOps && <><button className="small-button" onClick={() => onEditSale(row)}>{sale ? 'Edit' : 'Fix sale'}</button><button className="small-button danger-button" onClick={(event) => runAction(() => onUndoSale(row), event)}>Reopen</button></>}</span></div> }) : <div className="blank-slate"><ClipboardList size={22}/><strong>No transactions yet</strong><p>Transactions linked to this party will appear here.</p></div>}</div>
    <div className="statement-section-title activity-title"><div><h2>Payments{kind === 'BUYER' ? ' & expenses' : ''}</h2><p>Recorded account entries. Voided records remain visible for review.</p></div></div><div className="panel activity-list">{[...partyPayments.map((row) => ({ date: row.paymentDate, title: 'Payment', detail: `${row.paymentMethod}${row.transactionId ? ` · ${row.transactionNumber ?? row.transactionId}` : ''}${row.reference ? ` · ${row.reference}` : ''}`, amount: row.amount, kind: 'payment', payment: row, expense: undefined })), ...partyExpenseHistory.map((row) => ({ date: row.date, title: row.expenseType.replaceAll('_', ' '), detail: row.description || 'Expense', amount: row.amount, kind: 'expense', payment: undefined, expense: row }))].sort((a, b) => b.date.localeCompare(a.date)).map((row, index) => <div className={`activity-row ${row.payment?.status === 'INACTIVE' || row.expense?.status === 'INACTIVE' ? 'voided-row' : ''}`} key={`${row.kind}-${row.date}-${index}`}><span className={`activity-mark ${row.kind}`}>{row.kind === 'payment' ? '↓' : '−'}</span><span><strong>{row.title}{row.payment?.status === 'INACTIVE' || row.expense?.status === 'INACTIVE' ? ' · VOIDED' : ''}</strong><small>{row.date} · {row.detail} · {seasons.find((season) => season.id === (row.payment?.seasonId ?? row.expense?.seasonId))?.name ?? 'Season'}</small></span><b>{formatRupees(row.amount)}</b>{canManageMoney && row.payment?.status === 'ACTIVE' && <span className="activity-actions"><button className="small-button" onClick={() => onEditPayment(row.payment!)}>Edit</button><button className="small-button danger-button" onClick={(event) => runAction(() => onVoidPayment(row.payment!), event)}>Void</button></span>}{isAdmin && row.expense?.status === 'ACTIVE' && <span className="activity-actions"><button className="small-button" onClick={() => onEditExpense(row.expense!)}>Edit</button><button className="small-button danger-button" onClick={(event) => runAction(() => onVoidExpense(row.expense!), event)}>Void</button></span>}</div>)}{partyPayments.length + partyExpenseHistory.length === 0 && <div className="activity-empty">No payments or expenses recorded yet.</div>}</div>
  </section>
}

function Field({ label, name, type = 'text', required, min, max, step, placeholder, defaultValue, minLength, maxLength, pattern, autoComplete, inputMode, title }: { label: string; name: string; type?: string; required?: boolean; min?: string; max?: string; step?: string; placeholder?: string; defaultValue?: string; minLength?: number; maxLength?: number; pattern?: string; autoComplete?: string; inputMode?: 'numeric' | 'text' | 'tel' | 'email' | 'url' | 'decimal' | 'search' | 'none'; title?: string }) {
  return <label className="form-field"><span>{label}{required ? ' *' : ''}</span><input name={name} type={type} required={required} min={min} max={max} step={step} minLength={minLength} maxLength={maxLength} pattern={pattern} autoComplete={autoComplete} inputMode={inputMode} title={title} placeholder={placeholder} defaultValue={defaultValue}/></label>
}

function ArrivalForm({ kisans, crops, varieties, initial, onSubmit, onCancel, onAddKisan }: { kisans: Kisan[]; crops: Crop[]; varieties: Variety[]; initial?: Transaction; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void; onAddKisan: () => void }) {
  const [cropId, setCropId] = useState(initial?.cropId ?? '')
  return <form className="form-grid" onSubmit={onSubmit}><label className="form-field"><span>Kisan *</span><select name="kisanId" required defaultValue={initial?.kisanId ?? ''}><option value="" disabled>Select a kisan</option>{kisans.filter((row) => row.status === 'ACTIVE').map((row) => <option key={row.id} value={row.id}>{row.name} · {row.mobile}</option>)}</select>{kisans.length === 0 && <small><button type="button" className="inline-link" onClick={onAddKisan}>Add a kisan first</button></small>}</label><label className="form-field"><span>Crop *</span><select name="cropId" required value={cropId} onChange={(event) => setCropId(event.target.value)}><option value="" disabled>Select a crop</option>{crops.filter((row) => row.status === 'ACTIVE').map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>{crops.length === 0 && <small>No crops yet. Add one from Crops &amp; Varieties.</small>}</label><label className="form-field"><span>Variety</span><select name="varietyId" defaultValue={initial?.varietyId ?? ''} disabled={!cropId}><option value="">No variety</option>{varieties.filter((row) => row.status === 'ACTIVE' && row.cropId === cropId).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Field label="Number of trolleys" name="trolleyCount" type="number" min="1" step="1" required defaultValue={initial ? String(initial.trolleyCount) : undefined}/><Field label="Arrival date" name="arrivalDate" type="date" defaultValue={initial?.arrivalDate ?? today()} required/><div className="form-note">Record the trolley count now. Enter exact quantity, buyer and price later when the produce is sold.</div><FormActions cancel={onCancel} saveLabel={initial ? 'Save correction' : 'Save arrival'} /></form>
}

function SettlementDetails({ transaction, kisanName, buyerName, onClose }: { transaction: Transaction; kisanName: string; buyerName: string; onClose: () => void }) {
  const settlement = calculateSaleSettlement(transaction)
  if (!settlement) return <div className="settlement-body"><p>Settlement cannot be calculated because this sale is missing quantity, price, or commission information.</p><FormActions cancel={onClose} saveLabel="Close" /></div>
  return <div className="settlement-body"><div className="settlement-parties"><div><small>KISAN</small><strong>{kisanName}</strong></div><div><small>BUYER</small><strong>{buyerName}</strong></div></div><div className="settlement-meta"><span>{transaction.saleDate}</span><span>{((transaction.quantityKg ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Qtl</span><span>₹{transaction.pricePerQuintal?.toLocaleString('en-IN')} / Qtl</span></div><div className="settlement-lines"><div><span>Gross sale value</span><strong>{formatRupees(settlement.grossSale)}</strong></div><div><span>Commission ({transaction.commissionPercent}%)</span><strong>− {formatRupees(settlement.commission)}</strong></div><div className="settlement-total"><span>Amount payable to Kisan</span><strong>{formatRupees(settlement.kisanPayable)}</strong></div><div className="settlement-total buyer-total"><span>Amount receivable from Buyer</span><strong>{formatRupees(settlement.buyerReceivable)}</strong></div></div><p className="settlement-note">Calculated as quantity × price per quintal. Kisan payable is gross sale less commission. Expenses and payments are tracked separately in the party account.</p><div className="form-actions"><button type="button" className="primary-button" onClick={onClose}>Done</button></div></div>
}

function FormActions({ cancel, saveLabel = 'Save record' }: { cancel: () => void; saveLabel?: string }) {
  return <div className="form-actions"><button type="button" className="secondary-button" onClick={cancel}>Cancel</button><button type="submit" className="primary-button">{saveLabel}</button></div>
}

function Modal({ title, close, children, error, onReconnect, reconnecting }: { title: string; close: () => void; children: React.ReactNode; error: string; onReconnect: () => void; reconnecting: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className="modal-card" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close"><X size={17}/></button></header>{error && <div className="notice error modal-error" role="alert"><span>{error}</span>{error.includes('sign-in expired') && <button className="secondary-button" onClick={onReconnect} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Reconnect Google'}</button>}</div>}{children}</section></div>
}
