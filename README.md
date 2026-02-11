# Chrome Tab & Bookmark Organizer

A Chrome Extension that scans your open tabs and bookmarks, exports them to spreadsheets, deduplicates, and suggests an organized folder structure — all with preview and undo.

## Install

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select this directory
4. The extension icon appears in your toolbar

## Usage

The extension works as a 4-step wizard:

### Step 1: Scan
Click **Scan Tabs & Bookmarks** to:
- Read all open tabs (with tab group names)
- Read all Chrome bookmarks
- Extract a 1-line summary from each open tab (meta description or first paragraph)
- Find duplicates across tabs and bookmarks

### Step 2: Export
Download CSV spreadsheets:
- **Tabs CSV** — all open tabs with title, URL, tab group, and summary
- **Bookmarks CSV** — all bookmarks with title, URL, folder path, and summary
- **Merged CSV** — deduplicated union of both lists

### Step 3: Organize
Click **Generate Organization** to build a suggested folder structure:
- **Quick Access** — your most frequently visited pages (based on Chrome history visit count)
- **Category folders** — remaining pages sorted by domain into categories like Development, Reading, Social, Media, etc.
- All folders are max **2 directory levels deep**
- The tree view shows what's new (green), moved (blue), unchanged (gray), or removed as a duplicate (red)

### Step 4: Apply
- **Download Backup** — exports your current bookmarks as an HTML file (standard Netscape format importable via `chrome://bookmarks`)
- **Apply Organization** — creates the new folder structure in your Bookmarks Bar
- **Undo** — restores bookmarks to their pre-apply state
- You can also manually restore by importing the backup HTML at any time

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read open tab titles and URLs |
| `tabGroups` | Read tab group names and colors |
| `bookmarks` | Read and modify bookmarks |
| `history` | Read visit counts to determine frequently accessed pages |
| `scripting` | Inject content script to extract page summaries |
| `<all_urls>` | Required by scripting API to access page content |

## File Structure

```
manifest.json     — Extension manifest (Manifest V3)
background.js     — Service worker handling Chrome API calls
popup.html        — Extension popup UI
popup.css         — Styles
popup.js          — UI logic, organization engine, CSV export
icons/            — Extension icons
```
