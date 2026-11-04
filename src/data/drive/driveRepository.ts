import type { AppSettings, AuditLog, Buyer, BuyerPayment, Crop, Expense, Kisan, KisanPayment, PartySeasonSummary, Season, Transaction, Variety } from '../../domain/models'

type DriveFile = { id: string; name: string; mimeType: string }
type MasterData = { kisans: Kisan[]; buyers: Buyer[]; crops: Crop[]; varieties: Variety[]; seasons: Season[]; summaryFilesVersion?: number; settings: AppSettings | null; auditLogs: AuditLog[] }
type SeasonData = { transactions: Transaction[]; expenses: Expense[]; buyerPayments: BuyerPayment[]; kisanPayments: KisanPayment[] }
export type BackupStatus = { name: string; createdAt: string; backupType: 'DAILY' | 'MANUAL'; fileCount: number }
const emptyMaster = (): MasterData => ({ kisans: [], buyers: [], crops: [], varieties: [], seasons: [], settings: null, auditLogs: [] })
const jsonMime = 'application/json'

export class DriveRepository {
  private readonly folderCache = new Map<string, string>()
  private readonly fileCache = new Map<string, string>()
  private readonly childrenCache = new Map<string, Promise<DriveFile[]>>()
  private dailyBackupPromise: Promise<string | null> | null = null
  private lastDailyBackupDay = ''

  constructor(private readonly accessToken: string) {}

  private clearLookupCaches(): void { this.folderCache.clear(); this.fileCache.clear(); this.childrenCache.clear() }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response
    try { response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${this.accessToken}`, ...init.headers } }) }
    catch { this.clearLookupCaches(); throw new Error('Could not connect to Google Drive. Check your internet connection and retry; your form values are still here.') }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
      if (response.status === 401) throw new Error('Google Drive sign-in expired. Reconnect Google to retry this save; your form data is still here.')
      const detail = payload?.error?.message
      if (response.status === 403) throw new Error(detail ? `Google Drive denied this request: ${detail}. Check that you signed into the correct account and can access the KisanMandi folder.` : 'Google Drive denied access. Check your account permissions and reconnect Google.')
      if (response.status === 404) { this.clearLookupCaches(); throw new Error('A Google Drive file or folder could not be found. Refresh the page and retry; your form values are still here.') }
      if (response.status === 429) { this.clearLookupCaches(); throw new Error('Google Drive is receiving too many requests right now. Wait a moment, then retry; your form values are still here.') }
      if (response.status >= 500) { this.clearLookupCaches(); throw new Error('Google Drive is temporarily unavailable. Wait a moment, then retry; your form values are still here.') }
      throw new Error(detail || `Google Drive request failed (${response.status}). Your form values are still here.`)
    }
    if (response.status === 204) return undefined as T
    const body = await response.text()
    return (body ? JSON.parse(body) : undefined) as T
  }

  private async listChildren(parentId?: string, rootFolderName = 'KisanMandi'): Promise<DriveFile[]> {
    const cacheKey = parentId ?? `root:${rootFolderName}`
    const cached = this.childrenCache.get(cacheKey)
    if (cached) return cached
    const safeName = rootFolderName.replaceAll("'", "\\'")
    const q = parentId ? `'${parentId}' in parents and trashed = false` : `'root' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    const pending = (async () => {
      const files: DriveFile[] = []
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({ q, pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType)' })
        if (pageToken) params.set('pageToken', pageToken)
        const result = await this.request<{ files?: DriveFile[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${params.toString()}`)
        files.push(...(result.files ?? []))
        pageToken = result.nextPageToken
      } while (pageToken)
      return files
    })()
    this.childrenCache.set(cacheKey, pending)
    return pending
  }

  private async folder(name: string, parentId?: string): Promise<string> {
    const cacheKey = `${parentId ?? 'root'}:${name}`
    const cached = this.folderCache.get(cacheKey)
    if (cached) return cached
    const match = (await this.listChildren(parentId, name)).find((item) => item.name === name && item.mimeType === 'application/vnd.google-apps.folder')
    if (match) { this.folderCache.set(cacheKey, match.id); return match.id }
    const created = await this.request<DriveFile>('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }) })
    this.childrenCache.delete(parentId ?? `root:${name}`)
    this.folderCache.set(cacheKey, created.id)
    return created.id
  }

  private async fileId(parentId: string, name: string): Promise<string | undefined> {
    const key = `${parentId}:${name}`
    const cached = this.fileCache.get(key)
    if (cached) return cached
    const match = (await this.listChildren(parentId)).find((item) => item.name === name && item.mimeType !== 'application/vnd.google-apps.folder')
    if (match) this.fileCache.set(key, match.id)
    return match?.id
  }

  private async writeJson<T>(parentId: string, name: string, value: T): Promise<void> {
    await this.ensureDailyBackup()
    await this.writeJsonRaw(parentId, name, value)
  }

  private async writeJsonRaw<T>(parentId: string, name: string, value: T): Promise<void> {
    const id = await this.fileId(parentId, name)
    const metadata = { name, mimeType: jsonMime, ...(id ? {} : { parents: [parentId] }) }
    const boundary = `kisanmandi_${crypto.randomUUID().replaceAll('-', '')}`
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${jsonMime}; charset=UTF-8\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`
    const endpoint = id ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart&fields=id` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id'
    const saved = await this.request<DriveFile>(endpoint, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
    this.childrenCache.delete(parentId)
    this.fileCache.set(`${parentId}:${name}`, saved.id)
  }

  private async readJson<T>(parentId: string, name: string, fallback: T): Promise<T> {
    const id = await this.fileId(parentId, name)
    if (!id) return fallback
    let response: Response
    try { response = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${this.accessToken}` } }) }
    catch { throw new Error(`Could not connect to Google Drive while reading ${name}. Check your internet connection and retry.`) }
    if (!response.ok) {
      if (response.status === 401) throw new Error('Google Drive sign-in expired. Reconnect Google to retry this save; your form data is still here.')
      if (response.status === 403) throw new Error(`Google Drive denied access to ${name}. Check that you signed into the correct account and can access the KisanMandi folder.`)
      if (response.status === 404) { this.clearLookupCaches(); throw new Error(`${name} could not be found in Google Drive. Refresh the page and retry.`) }
      if (response.status === 429) throw new Error('Google Drive is receiving too many requests right now. Wait a moment, then retry.')
      if (response.status >= 500) throw new Error('Google Drive is temporarily unavailable. Wait a moment, then retry.')
      throw new Error(`Could not read ${name} from Google Drive (${response.status}).`)
    }
    try { return await response.json() as T } catch { throw new Error(`The Drive file ${name} is not valid JSON. Restore it from a backup before editing.`) }
  }

  private async root(): Promise<string> { return this.folder('KisanMandi') }

  private dateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  private async ensureDailyBackup(): Promise<string | null> {
    const today = this.dateKey(new Date())
    if (this.lastDailyBackupDay === today) return null
    if (this.dailyBackupPromise) return this.dailyBackupPromise
    this.dailyBackupPromise = this.createBackupSnapshot(today, 'DAILY')
      .then((name) => { if (name) this.lastDailyBackupDay = today; return name })
      .finally(() => { this.dailyBackupPromise = null })
    return this.dailyBackupPromise
  }

  async createBackupNow(): Promise<string> {
    const timestamp = new Date()
    const name = `MANUAL-${this.dateKey(timestamp)}-${String(timestamp.getHours()).padStart(2, '0')}-${String(timestamp.getMinutes()).padStart(2, '0')}-${String(timestamp.getSeconds()).padStart(2, '0')}`
    const created = await this.createBackupSnapshot(name, 'MANUAL')
    if (!created) throw new Error('There is no KisanMandi data to back up yet.')
    return created
  }

  async getLatestBackupStatus(): Promise<BackupStatus | null> {
    const roots = await this.listChildren(undefined, 'KisanMandi Backups')
    const backupsFolder = roots.find((item) => item.name === 'KisanMandi Backups' && item.mimeType === 'application/vnd.google-apps.folder')
    if (!backupsFolder) return null
    const candidates = (await this.listChildren(backupsFolder.id))
      .filter((item) => item.mimeType === 'application/vnd.google-apps.folder' && /^(?:MANUAL-)?\d{4}-\d{2}-\d{2}/.test(item.name))
      .map((item) => ({ item, date: /^(?:MANUAL-)?(\d{4}-\d{2}-\d{2})/.exec(item.name)?.[1] ?? '' }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.item.name.localeCompare(a.item.name))
    if (!candidates.length) return null
    const dates = [...new Set(candidates.map((candidate) => candidate.date))]
    for (const date of dates) {
      const manifests = await Promise.all(candidates.filter((candidate) => candidate.date === date).map(async ({ item }) => ({
        item,
        manifest: await this.readJson<{ createdAt?: string; backupType?: 'DAILY' | 'MANUAL'; fileCount?: number } | null>(item.id, 'manifest.json', null),
      })))
      const latest = manifests.filter((row) => row.manifest?.createdAt).sort((a, b) => (b.manifest?.createdAt ?? '').localeCompare(a.manifest?.createdAt ?? ''))[0]
      if (latest?.manifest?.createdAt) return { name: latest.item.name, createdAt: latest.manifest.createdAt, backupType: latest.manifest.backupType ?? (latest.item.name.startsWith('MANUAL-') ? 'MANUAL' : 'DAILY'), fileCount: latest.manifest.fileCount ?? 0 }
    }
    return null
  }

  private async createBackupSnapshot(name: string, backupType: 'DAILY' | 'MANUAL'): Promise<string | null> {
    const liveRoot = await this.root()
    const liveFiles = await this.listChildren(liveRoot)
    if (liveFiles.length === 0) return null

    const backupsRoot = await this.folder('KisanMandi Backups')
    if (backupType === 'DAILY') {
      const existing = (await this.listChildren(backupsRoot)).find((item) => item.name === name && item.mimeType === 'application/vnd.google-apps.folder')
      if (existing) {
        const contents = await this.listChildren(existing.id)
        if (contents.some((item) => item.name === 'manifest.json')) { await this.pruneOldBackups(backupsRoot); return name }
        await this.deleteTree(existing.id, false)
      }
    }

    const snapshotFolder = await this.folder(name, backupsRoot)
    const snapshotRoot = await this.folder('KisanMandi', snapshotFolder)
    const copiedFiles: string[] = []
    try {
      await this.copyTree(liveRoot, snapshotRoot, '', copiedFiles)
      const manifest = { formatVersion: 1, backupType, createdAt: new Date().toISOString(), source: 'KisanMandi Google Drive folder', fileCount: copiedFiles.length, files: copiedFiles }
      await this.writeJsonRaw(snapshotFolder, 'manifest.json', manifest)
    } catch (reason) {
      await this.deleteTree(snapshotFolder, false).catch(() => undefined)
      await this.request<void>(`https://www.googleapis.com/drive/v3/files/${snapshotFolder}`, { method: 'DELETE' }).catch(() => undefined)
      this.childrenCache.clear()
      throw new Error(`Google Drive backup failed; no data change was made. ${reason instanceof Error ? reason.message : ''}`.trim())
    }
    await this.pruneOldBackups(backupsRoot)
    return name
  }

  private async copyTree(sourceFolderId: string, targetFolderId: string, path: string, copiedFiles: string[]): Promise<void> {
    const children = await this.listChildren(sourceFolderId)
    for (const child of children) {
      const childPath = path ? `${path}/${child.name}` : child.name
      if (child.mimeType === 'application/vnd.google-apps.folder') {
        const targetChild = await this.folder(child.name, targetFolderId)
        await this.copyTree(child.id, targetChild, childPath, copiedFiles)
      } else {
        await this.request<DriveFile>(`https://www.googleapis.com/drive/v3/files/${child.id}/copy?fields=id,name,mimeType`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: child.name, parents: [targetFolderId] }),
        })
        copiedFiles.push(childPath)
      }
    }
  }

  private async pruneOldBackups(backupsRoot: string): Promise<void> {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 89)
    const cutoffKey = this.dateKey(cutoff)
    const oldBackups = (await this.listChildren(backupsRoot)).filter((item) => {
      if (item.mimeType !== 'application/vnd.google-apps.folder') return false
      const date = /^(?:MANUAL-)?(\d{4}-\d{2}-\d{2})/.exec(item.name)?.[1]
      return Boolean(date && date < cutoffKey)
    })
    for (const backup of oldBackups) await this.deleteTree(backup.id, true)
  }

  private async deleteTree(folderId: string, deleteFolder: boolean): Promise<void> {
    for (const child of await this.listChildren(folderId)) {
      if (child.mimeType === 'application/vnd.google-apps.folder') await this.deleteTree(child.id, true)
      else await this.request<void>(`https://www.googleapis.com/drive/v3/files/${child.id}`, { method: 'DELETE' })
    }
    if (deleteFolder) await this.request<void>(`https://www.googleapis.com/drive/v3/files/${folderId}`, { method: 'DELETE' })
    this.childrenCache.delete(folderId)
  }
  async hasMasterFile(): Promise<boolean> { return Boolean(await this.fileId(await this.root(), 'master-data.json')) }
  async loadMaster(): Promise<MasterData> {
    const stored = await this.readJson<Partial<MasterData>>(await this.root(), 'master-data.json', emptyMaster())
    return {
      ...emptyMaster(), ...stored,
      kisans: Array.isArray(stored.kisans) ? stored.kisans : [],
      buyers: Array.isArray(stored.buyers) ? stored.buyers : [],
      crops: Array.isArray(stored.crops) ? stored.crops : [],
      varieties: Array.isArray(stored.varieties) ? stored.varieties : [],
      seasons: Array.isArray(stored.seasons) ? stored.seasons : [],
      auditLogs: Array.isArray(stored.auditLogs) ? stored.auditLogs : [],
    }
  }
  async saveMaster(value: MasterData): Promise<void> { await this.writeJson(await this.root(), 'master-data.json', value) }
  async loadSeason(seasonName: string): Promise<SeasonData> {
    const root = await this.root(); const seasonFolder = await this.folder(seasonName, root)
    const [transactions, expenses, buyerPayments, kisanPayments] = await Promise.all([
      this.readJson<Transaction[]>(seasonFolder, 'transactions.json', []),
      this.readJson<Expense[]>(seasonFolder, 'expenses.json', []),
      this.readJson<BuyerPayment[]>(seasonFolder, 'payments-from-buyers.json', []),
      this.readJson<KisanPayment[]>(seasonFolder, 'payments-to-kisans.json', []),
    ])
    return { transactions, expenses, buyerPayments, kisanPayments }
  }
  async loadTransactionsForSeasons(seasonNames: string[]): Promise<Transaction[]> {
    const root = await this.root()
    const folders = await this.listChildren(root)
    const rows = await Promise.all(seasonNames.map(async (seasonName) => {
      const seasonFolder = folders.find((item) => item.name === seasonName && item.mimeType === 'application/vnd.google-apps.folder')
      return seasonFolder ? this.readJson<Transaction[]>(seasonFolder.id, 'transactions.json', []) : []
    }))
    return rows.flat()
  }
  async findTransactionById(transactionId: string, seasonNames: string[]): Promise<Transaction | undefined> {
    const root = await this.root()
    const folders = await this.listChildren(root)
    const rows = await Promise.all(seasonNames.map(async (seasonName) => {
      const seasonFolder = folders.find((item) => item.name === seasonName && item.mimeType === 'application/vnd.google-apps.folder')
      return seasonFolder ? this.readJson<Transaction[]>(seasonFolder.id, 'transactions.json', []) : []
    }))
    return rows.flat().find((row) => row.id === transactionId)
  }
  async loadPaymentsForTransaction(transactionId: string, partyType: 'KISAN' | 'BUYER', seasonNames: string[]): Promise<(KisanPayment | BuyerPayment)[]> {
    const root = await this.root()
    const fileName = partyType === 'KISAN' ? 'payments-to-kisans.json' : 'payments-from-buyers.json'
    const folders = await this.listChildren(root)
    const rows = await Promise.all(seasonNames.map(async (seasonName) => {
      const seasonFolder = folders.find((item) => item.name === seasonName && item.mimeType === 'application/vnd.google-apps.folder')
      if (!seasonFolder) return []
      return partyType === 'KISAN'
        ? this.readJson<KisanPayment[]>(seasonFolder.id, fileName, [])
        : this.readJson<BuyerPayment[]>(seasonFolder.id, fileName, [])
    }))
    return rows.flat().filter((row) => row.transactionId === transactionId)
  }
  async saveSeason(seasonName: string, value: SeasonData): Promise<void> {
    const root = await this.root(); const seasonFolder = await this.folder(seasonName, root)
    await Promise.all([
      this.writeJson(seasonFolder, 'transactions.json', value.transactions),
      this.writeJson(seasonFolder, 'expenses.json', value.expenses),
      this.writeJson(seasonFolder, 'payments-from-buyers.json', value.buyerPayments),
      this.writeJson(seasonFolder, 'payments-to-kisans.json', value.kisanPayments),
    ])
  }
  private summaryFile(kind: PartySeasonSummary['partyType']): string {
    return kind === 'KISAN' ? 'kisan-payment-summaries.json' : 'buyer-payment-summaries.json'
  }
  async loadPartySummaries(kind: PartySeasonSummary['partyType']): Promise<PartySeasonSummary[]> {
    return this.readJson(await this.root(), this.summaryFile(kind), [])
  }
  async savePartySummaries(kind: PartySeasonSummary['partyType'], rows: PartySeasonSummary[]): Promise<void> {
    await this.writeJson(await this.root(), this.summaryFile(kind), rows)
  }
  async loadAllPartySummaries(): Promise<PartySeasonSummary[]> {
    const [kisans, buyers] = await Promise.all([this.loadPartySummaries('KISAN'), this.loadPartySummaries('BUYER')])
    return [...kisans, ...buyers]
  }
  async updatePartySummariesForSeason(seasonId: string, nextSeasonRows: PartySeasonSummary[]): Promise<void> {
    for (const kind of ['KISAN', 'BUYER'] as const) {
      const existing = await this.loadPartySummaries(kind)
      const next = [...existing.filter((row) => row.seasonId !== seasonId), ...nextSeasonRows.filter((row) => row.partyType === kind)]
      const valuesChanged = existing.filter((row) => row.seasonId === seasonId).length !== next.filter((row) => row.seasonId === seasonId).length
        || existing.filter((row) => row.seasonId === seasonId).some((oldRow) => {
          const newRow = next.find((row) => row.id === oldRow.id)
          return !newRow || oldRow.grossSales !== newRow.grossSales || oldRow.commission !== newRow.commission || oldRow.labourCharge !== newRow.labourCharge || oldRow.expenses !== newRow.expenses || oldRow.payments !== newRow.payments || oldRow.payableOrReceivable !== newRow.payableOrReceivable || oldRow.outstanding !== newRow.outstanding
        })
        || nextSeasonRows.some((row) => row.partyType === kind && !existing.some((oldRow) => oldRow.id === row.id))
      if (valuesChanged) await this.savePartySummaries(kind, next)
    }
  }
  async migrateLegacySeasonSummaries(master: MasterData): Promise<{ master: MasterData; summaries: PartySeasonSummary[] }> {
    const rawMaster = master as MasterData & { partySeasonSummaries?: PartySeasonSummary[]; summaryStorageVersion?: number }
    if (rawMaster.summaryFilesVersion === 1) return { master, summaries: await this.loadAllPartySummaries() }
    const legacySeasonRows = (await Promise.all(master.seasons.map((season) => this.loadLegacySeasonSummary(season.name)))).flat()
    const migrated = new Map(legacySeasonRows.map((row) => [row.id, row]))
    for (const row of rawMaster.partySeasonSummaries ?? []) migrated.set(row.id, row)
    const allRows = [...migrated.values()]
    const kisanRows = allRows.filter((row) => row.partyType === 'KISAN')
    const buyerRows = allRows.filter((row) => row.partyType === 'BUYER')
    const oldKisans = await this.loadPartySummaries('KISAN')
    const oldBuyers = await this.loadPartySummaries('BUYER')
    const hasLegacyMaster = Boolean(rawMaster.partySeasonSummaries?.length)
    const hasLegacySeasonRows = legacySeasonRows.length > 0
    if (hasLegacyMaster || hasLegacySeasonRows || !oldKisans.length && kisanRows.length || !oldBuyers.length && buyerRows.length) {
      await this.savePartySummaries('KISAN', [...new Map([...oldKisans, ...kisanRows].map((row) => [row.id, row])).values()])
      await this.savePartySummaries('BUYER', [...new Map([...oldBuyers, ...buyerRows].map((row) => [row.id, row])).values()])
    }
    const { partySeasonSummaries: _legacy, summaryStorageVersion: _oldVersion, ...masterWithoutLegacySummary } = rawMaster
    void _legacy; void _oldVersion
    const nextMaster: MasterData = { ...masterWithoutLegacySummary, summaryFilesVersion: 1 }
    if (rawMaster.summaryFilesVersion !== 1) await this.saveMaster(nextMaster)
    if (hasLegacySeasonRows) await Promise.all(master.seasons.map((season) => this.removeLegacySeasonSummary(season.name)))
    return { master: nextMaster, summaries: await this.loadAllPartySummaries() }
  }
  async loadLegacySeasonSummary(seasonName: string): Promise<PartySeasonSummary[]> {
    const folder = await this.folder(seasonName, await this.root())
    return this.readJson<PartySeasonSummary[]>(folder, 'party-summaries.json', [])
  }
  async removeLegacySeasonSummary(seasonName: string): Promise<void> {
    const folder = await this.folder(seasonName, await this.root())
    const id = await this.fileId(folder, 'party-summaries.json')
    if (!id) return
    await this.request<void>(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' })
    this.fileCache.delete(`${folder}:party-summaries.json`)
    this.childrenCache.delete(folder)
  }

  async clearAllData(): Promise<void> {
    const root = await this.root()
    const removeChildren = async (parentId: string): Promise<void> => {
      for (const child of await this.listChildren(parentId)) {
        if (child.mimeType === 'application/vnd.google-apps.folder') await removeChildren(child.id)
        await this.request<void>(`https://www.googleapis.com/drive/v3/files/${child.id}`, { method: 'DELETE' })
      }
    }
    await removeChildren(root)
    this.folderCache.clear()
    this.fileCache.clear()
    this.childrenCache.clear()
  }
}

export type { MasterData, SeasonData }
