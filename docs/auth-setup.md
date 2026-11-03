# Version 1 Google sign-in

Version 1 uses one Google account for sign-in and asks the signed-in user to choose a local Viewer or Editor profile. Viewer is selected by default. Profiles are interface modes only: anyone who can sign into the configured Google account can choose Editor.

## Configure Google sign-in

1. In Google Cloud Console, create or select a project and configure the OAuth consent screen.
2. Create an OAuth client ID with application type **Web application**.
3. Add the app origin to **Authorized JavaScript origins** (for local development, `http://localhost:5173`; add the production origin when deployed).
4. Copy `.env.example` to `.env.local` and set `VITE_GOOGLE_CLIENT_ID` to the Web client ID. Restart the Vite dev server after changing the file.

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Do not use an OAuth client secret in the browser app. The Google sign-in flow requests basic identity and `drive.file` access for the future Drive integration.

## Current data boundary

Google sign-in and the Viewer/Editor selector are implemented. Operational records still live in IndexedDB in this browser; Drive reads and writes and migration of existing local records have not been implemented yet. Firebase authentication and staff account management are Version 2 and are not required for Version 1.
