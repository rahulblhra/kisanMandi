import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Cloud, Eye, Leaf, PencilLine, ShieldCheck } from 'lucide-react'
import { googleSignInConfigured, setGoogleClient } from './auth'
import type { AppProfile, SignedInUser } from './auth'

interface GoogleIdentity {
  accounts: { oauth2: {
    initTokenClient(options: {
      client_id: string
      scope: string
      callback: (response: { access_token?: string; expires_in?: string; error?: string }) => void
      error_callback: () => void
    }): { requestAccessToken(options?: { prompt?: string }): void }
  } }
}
declare global { interface Window { google?: GoogleIdentity } }

interface AuthContextValue { user: SignedInUser; signOut: () => void; setProfile: (profile: AppProfile) => void; reauthorize: () => Promise<void> }
const AuthContext = createContext<AuthContextValue | null>(null)
export const useAuth = () => {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthGate.')
  return value
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Omit<SignedInUser, 'profile'> | null>(null)
  const [profile, setProfileState] = useState<AppProfile>('viewer')
  const [profileConfirmed, setProfileConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(() => localStorage.getItem('kisan-mandi-remembered-session') === '1')

  useEffect(() => {
    if (!restoring) return
    let cancelled = false
    const restore = async () => {
      for (let attempt = 0; attempt < 30 && !window.google?.accounts.oauth2; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 150))
        if (cancelled) return
      }
      if (cancelled) return
      if (!googleSignInConfigured || !window.google?.accounts.oauth2) { setRestoring(false); return }
      setGoogleClient((nextIdentity) => {
        if (cancelled) return
        const rememberedEmail = localStorage.getItem('kisan-mandi-account-email')
        if (rememberedEmail && rememberedEmail.toLowerCase() !== nextIdentity.email.toLowerCase()) {
          setError(`This browser is signed in to a different Google account (${nextIdentity.email}). Choose the account that owns this Drive workspace.`)
          setRestoring(false)
          return
        }
        const savedProfile = localStorage.getItem('kisan-mandi-profile')
        const nextProfile = savedProfile === 'editor' ? 'editor' : 'viewer'
        setIdentity(nextIdentity); setProfileState(nextProfile)
        setProfileConfirmed(localStorage.getItem('kisan-mandi-profile-confirmed') === '1')
        setRestoring(false)
      }, () => { if (!cancelled) setRestoring(false) }, 'none')()
    }
    void restore()
    return () => { cancelled = true }
  }, [restoring])

  const startSignIn = () => {
    setError('')
    if (!googleSignInConfigured) { setError('Add VITE_GOOGLE_CLIENT_ID to .env.local to enable Google sign-in.'); return }
    if (!window.google?.accounts.oauth2) { setError('Google sign-in is still loading. Refresh and try again.'); return }
    setBusy(true)
    setGoogleClient((user) => { localStorage.setItem('kisan-mandi-remembered-session', '1'); localStorage.setItem('kisan-mandi-account-email', user.email); setIdentity(user); setProfileState('viewer'); localStorage.setItem('kisan-mandi-profile', 'viewer'); setProfileConfirmed(false); localStorage.removeItem('kisan-mandi-profile-confirmed'); setBusy(false) }, (message) => { setError(message); setBusy(false) })()
  }

  const signOut = useCallback(() => { localStorage.removeItem('kisan-mandi-remembered-session'); localStorage.removeItem('kisan-mandi-account-email'); localStorage.removeItem('kisan-mandi-profile'); localStorage.removeItem('kisan-mandi-profile-confirmed'); setIdentity(null); setProfileState('viewer'); setProfileConfirmed(false); setError('') }, [])
  const setProfile = useCallback((next: AppProfile) => { setProfileState(next); localStorage.setItem('kisan-mandi-profile', next) }, [])
  const reauthorize = useCallback(() => new Promise<void>((resolve, reject) => {
    if (!window.google?.accounts.oauth2) { reject(new Error('Google sign-in is still loading. Refresh and try again.')); return }
    setBusy(true)
    setGoogleClient((nextIdentity) => {
      if (identity && identity.email.toLowerCase() !== nextIdentity.email.toLowerCase()) {
        setBusy(false); reject(new Error(`Google reconnected as ${nextIdentity.email}. Sign out and choose ${identity.email} to access this Drive workspace.`)); return
      }
      setIdentity((current) => current ? { ...current, ...nextIdentity } : nextIdentity); setBusy(false); resolve()
    }, (message) => { setBusy(false); reject(new Error(message)) })()
  }), [identity])
  const user = useMemo(() => identity ? { ...identity, profile } : null, [identity, profile])
  const value = useMemo(() => user ? { user, signOut, setProfile, reauthorize } : null, [user, signOut, setProfile, reauthorize])

  if (!identity) return <div className="auth-screen"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Leaf size={20}/></span><span>Kisan<span className="brand-light">Mandi</span></span></div><div className="eyebrow">GOOGLE ACCOUNT</div><h1>{restoring ? 'Restoring your session…' : 'Sign in to continue'}</h1><p>{restoring ? 'Checking whether this browser still has access to your Google account.' : 'Sign in with the Google account that owns this mandi workspace.'}</p>{error && <div className="notice error" role="alert">{error}</div>}{!restoring && <button className="primary-button google-login-button" onClick={startSignIn} disabled={busy}><ShieldCheck size={16}/>{busy ? 'Signing in…' : 'Continue with Google'}</button>}<div className="auth-footer"><Cloud size={14}/> Version 1 · single Google account</div></section></div>
  if (identity && !profileConfirmed) return <div className="auth-screen"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Leaf size={20}/></span><span>Kisan<span className="brand-light">Mandi</span></span></div><div className="eyebrow">PROFILE</div><h1>How will you use KisanMandi?</h1><p>Signed in as {identity.email}. Viewer is selected by default.</p><div className="profile-choice-list"><button className={`profile-choice ${profile === 'viewer' ? 'selected' : ''}`} onClick={() => setProfile('viewer')}><Eye size={18}/><span><strong>Viewer</strong><small>View mandi data without editing.</small></span><span className="choice-check">{profile === 'viewer' ? '✓' : ''}</span></button><button className={`profile-choice ${profile === 'editor' ? 'selected' : ''}`} onClick={() => setProfile('editor')}><PencilLine size={18}/><span><strong>Editor</strong><small>Record and change data saved to this Google Drive.</small></span><span className="choice-check">{profile === 'editor' ? '✓' : ''}</span></button></div><div className="form-note">Profiles are local convenience modes in Version 1. Anyone signed into this Google account can choose Editor.</div><button className="primary-button" onClick={() => { localStorage.setItem('kisan-mandi-profile-confirmed', '1'); setProfileConfirmed(true) }}>Continue as {profile === 'viewer' ? 'Viewer' : 'Editor'}</button><button className="auth-signout" onClick={signOut}>Sign out</button></section></div>
  if (!user || !value) return null
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
