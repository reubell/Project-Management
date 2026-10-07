# Project Tasks

A simple, free task list organized by project. No account, no subscription, no build step.

## Features

- **Projects** in the sidebar, with a count of open tasks
- **Tasks** are either open or completed. Completed tasks fold into a section at the bottom
- **Files**: drag files from your computer onto any task, or click a task and use *browse*
- **Notes** on each task (click the task to open it)
- **Move a task** to another project by dragging it onto that project in the sidebar
- **Google Drive sync**: tasks and files back up automatically and show up on
  every phone and computer you connect
- **Back up / Restore** saves everything, files included, to a single `.json` file
- Works offline, on phones, and in dark mode

## Running it

Open `index.html` in Chrome, Edge, Firefox or Safari. That's it.

### Hosted on GitHub Pages

1. The repo must be public for free GitHub Pages. Only the app's code becomes
   visible; your tasks and files are never stored in the repo.
   (Settings → General → Danger Zone → Change visibility → Public)
2. Settings → Pages → Source: **Deploy from a branch** → pick
   `claude/simple-task-list-app-wy4c55` and `/ (root)` → Save.
3. After a minute the app is live at
   **https://reubell.github.io/Project-Management/**. Bookmark it, or on a phone
   use "Add to Home Screen".

## Where your data lives

Everything is saved on the device first, so the app opens instantly and works
offline. When Google Drive is connected, it also syncs in the background (every
change, plus every minute while open) to a **Project Tasks** folder in your Drive:

- `tasks.json`: all projects and tasks
- `Files/`: every attached file, as normal Drive files you can open anywhere

Deleted attachments go to Drive's trash, where they stay for 30 days. Other
devices download an attachment the first time you open it there.

Google sign-ins for web apps last one hour. When you open the app after that, it
briefly bounces through Google to refresh, then comes straight back. If that
doesn't work, a **Reconnect** button appears. Your changes stay safe on the device
until it syncs.

## Google Drive sync: one-time setup (about 10 minutes)

Google needs to know the app exists before it will let it use your Drive.
This is free.

1. Go to <https://console.cloud.google.com/>, sign in, and create a project
   (name it "Project Tasks").
2. **APIs & Services → Library**, search **Google Drive API**, then **Enable**.
3. **Google Auth Platform → Get started**. App name "Project Tasks", your email
   for support and contact, Audience **External**, then **Create**.
4. **Audience → Test users → Add users**, then add your own Gmail address.
5. **Clients → Create client**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://reubell.github.io`
   - Authorized redirect URIs: `https://reubell.github.io/Project-Management/`
   - **Create**, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).
6. Put the Client ID in `config.js` (on GitHub: open the file, click the pencil,
   paste it between the quotes, commit). It is not a secret.
7. Open the app and tap **Connect Google Drive** on each device. Google will warn
   that the app isn't verified. That's expected for your own app, so tap
   **Continue**.

## Files

| File         | What it is                         |
|--------------|------------------------------------|
| `index.html` | Page layout                        |
| `style.css`  | Styling                            |
| `app.js`     | App behavior, storage and syncing  |
| `drive.js`   | Google sign-in and Drive calls     |
| `config.js`  | Your Google Client ID              |
