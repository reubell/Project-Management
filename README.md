# Project Tasks

A simple, free task list organized by project. No account, no subscription, no build step.

## Features

- **Projects** in the sidebar, with a count of open tasks
- **Tasks** are either open or completed. Completed tasks fold into a section at the bottom
- **Files**: drag files from your computer onto any task, or click a task and use *browse*
- **Notes** on each task (click the task to open it)
- **Move a task** to another project by dragging it onto that project in the sidebar
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

Everything, attached files included, is stored in your browser on this device
(IndexedDB). Nothing is uploaded anywhere. This means:

- Data does not sync between devices or browsers
- Clearing your browser's site data erases it, so use **Back up** now and then

## Files

| File         | What it is                         |
|--------------|------------------------------------|
| `index.html` | Page layout                        |
| `style.css`  | Styling                            |
| `app.js`     | All behavior and storage           |
