# Shared Google Drive storage and app users

## Goal

Keep the mandi records in one dedicated Google Drive account/folder while letting staff sign in to the app with their own accounts and role-specific access.

The requested list contains **four roles**: Admin, Manager, Operator, and Viewer.

## Proposed architecture

- The dedicated Google account signs in to the app with Google and is bootstrapped as the first Admin. Its email is the Admin username and must match the configured owner email.
- Staff authenticate with an individual username and password. Firebase Authentication handles password storage; a server-side mapping converts normalized usernames to private Firebase Auth identities.
- A Firebase Cloud Functions backend verifies every signed-in user's token and checks their role on every read and write. Hiding buttons in the React app is only a usability feature; it is not the security boundary.
- The Admin connects Drive once through a server-side Google OAuth authorization flow. The backend stores the resulting refresh token in Secret Manager and uses it to create/read/update the data file in the Admin's Drive. The browser never receives the refresh token.
- Store one versioned JSON data file in that folder initially. The backend serializes updates, validates records and writes audit events. IndexedDB remains an offline cache; cloud data is authoritative whenever connected.
- Keep credentials, Firebase Admin SDK access and Drive authorization in server-side secrets/configuration. Never ship them in the Vite bundle or PWA.
- Migrate existing IndexedDB records through an explicit one-time import and compare record counts/totals before switching the app to cloud-first operation.

The Drive authorization uses the Admin's Google account, so the data file is owned by and consumes storage from that account. Staff never need access to the owner's Drive. Google requires offline OAuth access for a backend to refresh credentials while the Admin is not present; the refresh token must stay server-side.

## Role permissions

| Role | View records | Arrivals | Sales | Kisan/Buyer payments | Manage users and settings |
|---|---:|---|---|---|---|
| Admin | Yes | All actions | All actions | Record, edit and void | Yes; full access |
| Manager | Yes | Create and correct | Record and correct | Record received and paid | No |
| Operator | Yes | Create | Record | No | No |
| Viewer | Yes | No changes | No changes | No changes | No |

Corrections for managers are included so operational mistakes can be fixed without granting user administration. The current user request does not specify who can add/edit/void expenses or change master data (Kisans, Buyers, Crops, Varieties, Seasons). Until confirmed, these should be Admin-only in the cloud permission policy.

## User administration

- Admin creates a staff account with a username, display name, initial password and one of the four roles.
- The backend creates the Firebase Auth identity and assigns the role claim; only the backend can assign or change roles.
- The first password is temporary and must be changed at first sign-in. Admin can reset a staff member's password but cannot read their current password.
- Admin can deactivate an account; every backend request checks account state as well as role.
- The first Admin account is provisioned once during setup, outside the public app. The app must not allow self-service signup or promotion to Admin.

## Setup required before Drive cutover

1. Create/select the Firebase project and enable Google sign-in for the Admin plus Firebase Auth for staff username/password accounts.
2. Configure Google OAuth as a web server client and request only the Drive scope needed for the selected app data file/folder.
3. Sign in as the storage account, authorize Drive once, and store the refresh token in Firebase Secret Manager.
4. Deploy the backend; configure the allowed Admin Google email, OAuth client, and function region.
5. Bootstrap the first Admin and test each role against both UI controls and backend authorization.
6. Import and reconcile the local IndexedDB records, then enable cloud-first writes.

No Google account password, refresh token, OAuth client secret or Firebase Admin credential should be pasted into the source tree or chat. Backend credentials belong in Secret Manager or a local ignored environment file. Staff passwords are never stored in Drive.

## Implementation boundary

The current app reads and writes IndexedDB directly from `src/app/App.tsx`; its existing repository interface is not yet used by the UI. Drive support should therefore be introduced behind a workspace data service, then the UI migrated to that service. Do not connect a browser Drive token directly to the application or treat client-only role checks as authorization.

## References

- [Firebase custom claims and role-based access control](https://firebase.google.com/docs/auth/admin/custom-claims)
- [Firebase callable functions](https://firebase.google.com/docs/functions/callable)
- [Google Apps Script web app execution identities](https://developers.google.com/apps-script/guides/web)
- [Google OAuth server-side offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Drive file ownership](https://developers.google.com/workspace/drive/api/guides/create-file)
