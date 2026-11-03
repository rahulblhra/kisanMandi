# Kisan Mandi — local-first foundation

This is Phase 1 of the Mandi Commission Agent Management System. It runs locally as a React + TypeScript PWA and uses IndexedDB as its working database. Google Drive, OAuth, cloud synchronization, business workflows, and financial calculations are intentionally not implemented yet.

## Run locally

```sh
npm install
npm run dev
```

To create a production build, run `npm run build`. The app shell is precached by the PWA service worker, so after the first online visit it can reopen offline. IndexedDB data remains on this browser/device.

## Phase 1 data architecture

- `src/domain/models.ts` owns shared entity and sync types.
- `src/data/indexeddb/database.ts` owns the versioned IndexedDB schema, stores, and indexes.
- `src/data/repositories/recordRepository.ts` provides a storage-neutral repository interface and IndexedDB implementation.
- `src/app/App.tsx` is a dashboard placeholder and initializes the database; feature data access belongs in services/repositories as the next phases are built.

Stores are separated for global masters, seasons, season transactions/expenses/payments, sync queue, and sync metadata. The sync stores are scaffolding only. A future sync adapter can consume them and write JSON table files to Drive without letting UI components access Drive directly.

## Local data

The current schema is initialized on first app load. No sample records are seeded. Browser storage can be inspected in developer tools under Application → IndexedDB → `kisan-mandi`.
