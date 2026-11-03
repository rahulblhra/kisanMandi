import type { IDBPDatabase, StoreNames } from 'idb'
import type { MandiDatabase } from '../indexeddb/database'

export interface IRepository<T extends { id: string }> {
  get(id: string): Promise<T | undefined>
  list(): Promise<T[]>
  put(record: T): Promise<void>
}

export class IndexedDbRepository<T extends { id: string }, S extends StoreNames<MandiDatabase>> implements IRepository<T> {
  constructor(private readonly database: IDBPDatabase<MandiDatabase>, private readonly store: S) {}

  get(id: string): Promise<T | undefined> {
    return this.database.get(this.store, id) as Promise<T | undefined>
  }

  list(): Promise<T[]> {
    return this.database.getAll(this.store) as unknown as Promise<T[]>
  }

  async put(record: T): Promise<void> {
    await this.database.put(this.store, record as unknown as MandiDatabase[S]['value'])
  }
}
