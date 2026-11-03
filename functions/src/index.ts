import { initializeApp } from 'firebase-admin/app'
import { getAuth, type UserRecord } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'
import { setGlobalOptions } from 'firebase-functions/v2'

initializeApp()
setGlobalOptions({ region: 'asia-south1' })
const db = getFirestore()
const configuredAdminEmail = defineString('ADMIN_GOOGLE_EMAIL')

type AppRole = 'admin' | 'manager' | 'operator' | 'viewer'
const roles: AppRole[] = ['admin', 'manager', 'operator', 'viewer']
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,31}$/
const identityDomain = 'users.kisanmandi.invalid'

function normalizedUsername(value: unknown): string {
  const username = String(value ?? '').trim().toLowerCase()
  if (!usernamePattern.test(username)) throw new HttpsError('invalid-argument', 'Username must be 3–32 characters using letters, numbers, dots, dashes or underscores.')
  return username
}

function requireSignedIn(request: { auth?: { uid: string; token: Record<string, unknown> } }): NonNullable<typeof request.auth> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  return request.auth
}

async function requireActive(request: { auth?: { uid: string; token: Record<string, unknown> } }): Promise<NonNullable<typeof request.auth>> {
  const auth = requireSignedIn(request)
  const profile = await db.doc(`users/${auth.uid}`).get()
  if (!profile.exists || profile.get('active') !== true) throw new HttpsError('permission-denied', 'This account is not active.')
  return auth
}

async function requireAdmin(request: { auth?: { uid: string; token: Record<string, unknown> } }): Promise<NonNullable<typeof request.auth>> {
  const auth = await requireActive(request)
  if (auth.token.role !== 'admin') throw new HttpsError('permission-denied', 'Only the Admin can manage staff accounts.')
  return auth
}

export const bootstrapAdmin = onCall(async (request) => {
  const auth = requireSignedIn(request)
  const email = String(auth.token.email ?? '').trim().toLowerCase()
  const expectedEmail = configuredAdminEmail.value().trim().toLowerCase()
  const provider = (auth.token.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider
  if (!expectedEmail || email !== expectedEmail || provider !== 'google.com' || auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Sign in with the configured, verified Admin Google account.')
  }

  const bootstrapRef = db.doc('system/adminBootstrap')
  await db.runTransaction(async (transaction) => {
    const bootstrap = await transaction.get(bootstrapRef)
    if (bootstrap.exists && bootstrap.get('complete') === true && bootstrap.get('uid') !== auth.uid) {
      throw new HttpsError('permission-denied', 'The initial Admin account has already been provisioned.')
    }
    transaction.set(bootstrapRef, { complete: true, uid: auth.uid, email, updatedAt: FieldValue.serverTimestamp() })
  })
  await getAuth().setCustomUserClaims(auth.uid, { role: 'admin', username: email, mustChangePassword: false })
  await db.doc(`users/${auth.uid}`).set({ uid: auth.uid, username: email, email, role: 'admin', active: true, createdAt: FieldValue.serverTimestamp() }, { merge: true })
  return { role: 'admin' as const }
})

export const createStaffUser = onCall(async (request) => {
  await requireAdmin(request)
  const username = normalizedUsername(request.data?.username)
  const displayName = String(request.data?.displayName ?? '').trim()
  const password = String(request.data?.temporaryPassword ?? '')
  const role = String(request.data?.role ?? '') as AppRole
  if (!displayName || displayName.length > 80) throw new HttpsError('invalid-argument', 'Enter a display name up to 80 characters.')
  if (password.length < 10) throw new HttpsError('invalid-argument', 'Temporary password must be at least 10 characters.')
  if (!roles.includes(role) || role === 'admin') throw new HttpsError('invalid-argument', 'Choose Manager, Operator or Viewer. Admin access is provisioned separately.')

  const usernameRef = db.doc(`usernames/${username}`)
  const reservation = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(usernameRef)
    if (existing.exists) throw new HttpsError('already-exists', 'That username is already in use.')
    transaction.create(usernameRef, { state: 'creating', createdAt: FieldValue.serverTimestamp() })
    return true
  })
  if (!reservation) throw new HttpsError('internal', 'Could not reserve username.')

  const email = `${username}@${identityDomain}`
  let created: UserRecord | undefined
  try {
    created = await getAuth().createUser({ email, password, displayName, emailVerified: true, disabled: false })
    await getAuth().setCustomUserClaims(created.uid, { role, username, mustChangePassword: true })
    const batch = db.batch()
    batch.set(usernameRef, { uid: created.uid, username, state: 'active' })
    batch.set(db.doc(`users/${created.uid}`), { uid: created.uid, username, displayName, role, active: true, mustChangePassword: true, createdAt: FieldValue.serverTimestamp() })
    await batch.commit()
  } catch (error) {
    if (created) await getAuth().deleteUser(created.uid).catch(() => undefined)
    await usernameRef.delete().catch(() => undefined)
    if (error instanceof HttpsError) throw error
    throw new HttpsError('internal', 'Could not create the staff account.')
  }
  return { uid: created.uid, username, displayName, role, mustChangePassword: true }
})

export const listStaffUsers = onCall(async (request) => {
  await requireAdmin(request)
  const snapshot = await db.collection('users').orderBy('createdAt', 'desc').limit(500).get()
  return { users: snapshot.docs.map((document) => {
    const { uid, username, displayName, role, active, mustChangePassword } = document.data()
    return { uid, username, displayName, role, active, mustChangePassword }
  }).filter((user) => user.role !== 'admin') }
})

export const setStaffUserActive = onCall(async (request) => {
  const admin = await requireAdmin(request)
  const uid = String(request.data?.uid ?? '')
  const active = request.data?.active
  if (!uid || typeof active !== 'boolean') throw new HttpsError('invalid-argument', 'Select an account and an active state.')
  if (uid === admin.uid) throw new HttpsError('failed-precondition', 'The Admin cannot deactivate their own account.')
  const target = await getAuth().getUser(uid)
  if (target.customClaims?.role === 'admin') throw new HttpsError('permission-denied', 'Admin access cannot be changed here.')
  await getAuth().updateUser(uid, { disabled: !active })
  await db.doc(`users/${uid}`).set({ active, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  if (!active && target.customClaims?.username) await db.doc(`usernames/${target.customClaims.username}`).set({ state: 'disabled' }, { merge: true })
  if (active && target.customClaims?.username) await db.doc(`usernames/${target.customClaims.username}`).set({ state: 'active' }, { merge: true })
  return { uid, active }
})

export const completePasswordChange = onCall(async (request) => {
  const auth = await requireActive(request)
  const user = await getAuth().getUser(auth.uid)
  const claims = user.customClaims ?? {}
  if (claims.mustChangePassword !== true) return { complete: true }
  await getAuth().setCustomUserClaims(auth.uid, { ...claims, mustChangePassword: false })
  await db.doc(`users/${auth.uid}`).set({ mustChangePassword: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  return { complete: true }
})
