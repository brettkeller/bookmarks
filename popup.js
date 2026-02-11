// ============================================================
// State
// ============================================================
const state = {
  tabs: [],          // { title, url, groupName, summary }
  bookmarks: [],     // { id, title, url, folder, dateAdded, summary }
  bookmarkFolders: [],
  bookmarkTree: null,
  duplicates: [],    // { title, url, sources: [] }
  merged: [],        // deduplicated union
  visitCounts: {},   // url -> count
  orgPlan: null,     // proposed reorganization
  snapshotTree: null, // pre-apply bookmark snapshot for undo
  backupDone: false,
};

// ============================================================
// DOM helpers
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function goToStep(name) {
  $$('.section').forEach(s => s.classList.remove('active'));
  $(`#${name}-section`).classList.add('active');
  $$('.step').forEach(s => {
    s.classList.remove('active');
    // Mark previous steps as done
    const steps = ['scan', 'export', 'organize', 'apply'];
    const targetIdx = steps.indexOf(name);
    const thisIdx = steps.indexOf(s.dataset.step);
    if (thisIdx < targetIdx) s.classList.add('done');
    else s.classList.remove('done');
    if (s.dataset.step === name) s.classList.add('active');
  });
}

// ============================================================
// Step navigation
// ============================================================
$$('.step').forEach(s => s.addEventListener('click', () => goToStep(s.dataset.step)));
$('#btn-to-export').addEventListener('click', () => goToStep('export'));
$('#btn-to-organize').addEventListener('click', () => goToStep('organize'));
$('#btn-to-apply').addEventListener('click', () => goToStep('apply'));

// ============================================================
// Step 1: Scan
// ============================================================
$('#btn-scan').addEventListener('click', async () => {
  $('#btn-scan').disabled = true;
  show($('#scan-progress'));
  hide($('#scan-results'));
  setProgress('scan-fill', 5);
  setStatus('scan-status', 'Scanning open tabs...');

  // 1. Get tabs
  const tabResult = await sendMsg({ action: 'scanTabs' });
  if (!tabResult.ok) {
    setStatus('scan-status', 'Error: ' + tabResult.error);
    $('#btn-scan').disabled = false;
    return;
  }
  setProgress('scan-fill', 20);

  // 2. Get tab summaries
  setStatus('scan-status', 'Extracting page summaries...');
  const tabsWithSummary = [];
  const total = tabResult.tabs.length;
  for (let i = 0; i < total; i++) {
    const t = tabResult.tabs[i];
    let summary = '';
    // Only try to get summary for http(s) pages
    if (t.url.startsWith('http')) {
      const res = await sendMsg({ action: 'getSummary', tabId: t.id });
      summary = res.summary || '';
    }
    tabsWithSummary.push({ ...t, summary: truncate(summary, 120) });
    setProgress('scan-fill', 20 + Math.round((i / total) * 30));
  }
  state.tabs = tabsWithSummary;
  setProgress('scan-fill', 50);

  // 3. Get bookmarks
  setStatus('scan-status', 'Reading bookmarks...');
  const bmResult = await sendMsg({ action: 'scanBookmarks' });
  if (!bmResult.ok) {
    setStatus('scan-status', 'Error: ' + bmResult.error);
    $('#btn-scan').disabled = false;
    return;
  }
  state.bookmarks = bmResult.bookmarks;
  state.bookmarkFolders = bmResult.folders;
  state.bookmarkTree = bmResult.tree;
  setProgress('scan-fill', 70);

  // 4. Get summaries for bookmarks that are also open as tabs (reuse tab summary)
  setStatus('scan-status', 'Matching bookmark summaries...');
  const tabUrlMap = {};
  for (const t of state.tabs) {
    tabUrlMap[normalizeUrl(t.url)] = t.summary;
  }
  for (const bm of state.bookmarks) {
    bm.summary = tabUrlMap[normalizeUrl(bm.url)] || '';
  }
  setProgress('scan-fill', 80);

  // 5. Deduplicate
  setStatus('scan-status', 'Finding duplicates...');
  deduplicate();
  setProgress('scan-fill', 100);
  setStatus('scan-status', 'Scan complete!');

  // Render results
  renderScanResults();
  show($('#scan-results'));
  $('#btn-scan').disabled = false;
});

function deduplicate() {
  const seen = new Map(); // normalized url -> { title, url, sources: [] }
  const dupes = [];

  for (const t of state.tabs) {
    const key = normalizeUrl(t.url);
    if (!key) continue;
    if (seen.has(key)) {
      seen.get(key).sources.push('Tab');
    } else {
      seen.set(key, {
        title: t.title,
        url: t.url,
        summary: t.summary,
        groupName: t.groupName,
        sources: ['Tab'],
      });
    }
  }

  for (const bm of state.bookmarks) {
    const key = normalizeUrl(bm.url);
    if (!key) continue;
    if (seen.has(key)) {
      seen.get(key).sources.push('Bookmark');
      // Prefer bookmark title if tab title is empty
      if (!seen.get(key).title && bm.title) {
        seen.get(key).title = bm.title;
      }
      if (!seen.get(key).summary && bm.summary) {
        seen.get(key).summary = bm.summary;
      }
    } else {
      seen.set(key, {
        title: bm.title,
        url: bm.url,
        summary: bm.summary,
        folder: bm.folder,
        bookmarkId: bm.id,
        sources: ['Bookmark'],
      });
    }
  }

  // Items appearing more than once across lists or within bookmarks
  const allBookmarkUrls = state.bookmarks.map(b => normalizeUrl(b.url));
  const urlCountInBookmarks = {};
  for (const u of allBookmarkUrls) {
    urlCountInBookmarks[u] = (urlCountInBookmarks[u] || 0) + 1;
  }

  for (const [key, item] of seen) {
    const isDupe = item.sources.length > 1 ||
                   (item.sources.includes('Bookmark') && (urlCountInBookmarks[key] || 0) > 1);
    if (isDupe) {
      dupes.push({ title: item.title, url: item.url, sources: item.sources.join(', ') });
    }
  }

  state.duplicates = dupes;
  state.merged = Array.from(seen.values());
}

function renderScanResults() {
  $('#tab-count').textContent = state.tabs.length;
  const groupNames = new Set(state.tabs.map(t => t.groupName).filter(Boolean));
  $('#group-count').textContent = groupNames.size;
  $('#bookmark-count').textContent = state.bookmarks.length;
  $('#dupe-count').textContent = state.duplicates.length;

  // Tabs table
  const tabsTbody = $('#tabs-table tbody');
  tabsTbody.innerHTML = '';
  $('#tabs-badge').textContent = state.tabs.length;
  for (const t of state.tabs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td title="${esc(t.title)}">${esc(t.title)}</td>
      <td title="${esc(t.url)}">${esc(shortUrl(t.url))}</td>
      <td>${esc(t.groupName)}</td>
      <td title="${esc(t.summary)}">${esc(t.summary)}</td>`;
    tabsTbody.appendChild(tr);
  }

  // Bookmarks table
  const bmTbody = $('#bookmarks-table tbody');
  bmTbody.innerHTML = '';
  $('#bookmarks-badge').textContent = state.bookmarks.length;
  for (const bm of state.bookmarks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td title="${esc(bm.title)}">${esc(bm.title)}</td>
      <td title="${esc(bm.url)}">${esc(shortUrl(bm.url))}</td>
      <td>${esc(bm.folder)}</td>
      <td title="${esc(bm.summary)}">${esc(bm.summary)}</td>`;
    bmTbody.appendChild(tr);
  }

  // Duplicates table
  if (state.duplicates.length > 0) {
    show($('#dupes-preview'));
    const dupesTbody = $('#dupes-table tbody');
    dupesTbody.innerHTML = '';
    $('#dupes-badge').textContent = state.duplicates.length;
    for (const d of state.duplicates) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td title="${esc(d.title)}">${esc(d.title)}</td>
        <td title="${esc(d.url)}">${esc(shortUrl(d.url))}</td>
        <td>${esc(d.sources)}</td>`;
      dupesTbody.appendChild(tr);
    }
  }
}

// ============================================================
// Step 2: Export CSV
// ============================================================
$('#btn-export-tabs').addEventListener('click', () => {
  const rows = [['Title', 'URL', 'Tab Group', 'Summary']];
  for (const t of state.tabs) {
    rows.push([t.title, t.url, t.groupName, t.summary]);
  }
  downloadCSV(rows, 'chrome-tabs.csv');
  show($('#export-done'));
});

$('#btn-export-bookmarks').addEventListener('click', () => {
  const rows = [['Title', 'URL', 'Folder', 'Summary']];
  for (const bm of state.bookmarks) {
    rows.push([bm.title, bm.url, bm.folder, bm.summary]);
  }
  downloadCSV(rows, 'chrome-bookmarks.csv');
  show($('#export-done'));
});

$('#btn-export-merged').addEventListener('click', () => {
  const rows = [['Title', 'URL', 'Source', 'Group/Folder', 'Summary']];
  for (const item of state.merged) {
    rows.push([
      item.title,
      item.url,
      item.sources.join(' & '),
      item.groupName || item.folder || '',
      item.summary || '',
    ]);
  }
  downloadCSV(rows, 'merged-tabs-bookmarks.csv');
  show($('#export-done'));
});

// ============================================================
// Step 3: Organize
// ============================================================
$('#btn-generate-org').addEventListener('click', async () => {
  $('#btn-generate-org').disabled = true;
  show($('#org-progress'));
  hide($('#org-results'));
  setProgress('org-fill', 10);
  setStatus('org-status', 'Fetching visit history...');

  // Get visit counts for all unique URLs
  const allUrls = state.merged.map(m => m.url).filter(Boolean);
  const visitResult = await sendMsg({ action: 'getVisitCounts', urls: allUrls });
  if (visitResult.ok) {
    state.visitCounts = visitResult.counts;
  }
  setProgress('org-fill', 50);
  setStatus('org-status', 'Building organization plan...');

  // Generate organization
  state.orgPlan = buildOrganizationPlan();
  setProgress('org-fill', 100);
  setStatus('org-status', 'Organization plan ready!');

  renderOrgTree();
  show($('#org-results'));
  $('#btn-generate-org').disabled = false;
});

function buildOrganizationPlan() {
  const items = state.merged.map(m => ({
    ...m,
    visits: state.visitCounts[m.url] || 0,
    bookmarkId: null,
  }));

  // Find bookmark IDs for items that are already bookmarked
  const bmByUrl = {};
  for (const bm of state.bookmarks) {
    const key = normalizeUrl(bm.url);
    if (!bmByUrl[key]) bmByUrl[key] = [];
    bmByUrl[key].push(bm);
  }
  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (bmByUrl[key] && bmByUrl[key].length > 0) {
      item.bookmarkId = bmByUrl[key][0].id;
      // Mark extras as duplicates to remove
      item._dupeBookmarkIds = bmByUrl[key].slice(1).map(b => b.id);
    }
  }

  // Sort by visit count descending
  items.sort((a, b) => b.visits - a.visits);

  // Split into frequent (top 20% or >= 10 visits) and infrequent
  const freqThreshold = Math.max(
    items.length > 0 ? items[Math.floor(items.length * 0.2)]?.visits || 5 : 5,
    5
  );

  const frequent = items.filter(i => i.visits >= freqThreshold);
  const infrequent = items.filter(i => i.visits < freqThreshold);

  // Categorize infrequent items by domain-based categories
  const categories = categorizeByDomain(infrequent);

  // Build the plan structure
  const plan = {
    quickAccess: frequent.map(i => ({
      title: i.title,
      url: i.url,
      visits: i.visits,
      bookmarkId: i.bookmarkId,
      status: i.bookmarkId ? 'moved' : 'new',
      _dupeBookmarkIds: i._dupeBookmarkIds || [],
    })),
    categories: categories,
    duplicatesToRemove: [],
  };

  // Collect all duplicate bookmark IDs to remove
  for (const item of items) {
    if (item._dupeBookmarkIds) {
      for (const id of item._dupeBookmarkIds) {
        plan.duplicatesToRemove.push({ id, title: item.title, url: item.url });
      }
    }
  }

  return plan;
}

function categorizeByDomain(items) {
  // Map of domain patterns to category names
  const domainCategories = {
    'github.com': 'Development/GitHub',
    'gitlab.com': 'Development/GitLab',
    'stackoverflow.com': 'Development/StackOverflow',
    'developer.': 'Development/Docs',
    'docs.': 'Development/Docs',
    'medium.com': 'Reading/Articles',
    'substack.com': 'Reading/Newsletters',
    'news.ycombinator.com': 'Reading/News',
    'reddit.com': 'Reading/Reddit',
    'twitter.com': 'Social/Twitter',
    'x.com': 'Social/Twitter',
    'linkedin.com': 'Social/LinkedIn',
    'facebook.com': 'Social/Facebook',
    'instagram.com': 'Social/Instagram',
    'youtube.com': 'Media/YouTube',
    'spotify.com': 'Media/Music',
    'netflix.com': 'Media/Streaming',
    'twitch.tv': 'Media/Streaming',
    'amazon.com': 'Shopping/Amazon',
    'ebay.com': 'Shopping/eBay',
    'google.com/maps': 'Utilities/Maps',
    'calendar.google': 'Utilities/Calendar',
    'mail.google': 'Utilities/Email',
    'outlook.': 'Utilities/Email',
    'drive.google': 'Utilities/Cloud Storage',
    'dropbox.com': 'Utilities/Cloud Storage',
    'notion.so': 'Productivity/Notes',
    'trello.com': 'Productivity/Project Management',
    'asana.com': 'Productivity/Project Management',
    'jira.': 'Productivity/Project Management',
    'figma.com': 'Design/Figma',
    'canva.com': 'Design/Canva',
    'wikipedia.org': 'Reference/Wikipedia',
    '.edu': 'Reference/Education',
    '.gov': 'Reference/Government',
  };

  const categorized = {};

  for (const item of items) {
    let category = 'Other';
    try {
      const hostname = new URL(item.url).hostname;
      const fullUrl = item.url.toLowerCase();

      for (const [pattern, cat] of Object.entries(domainCategories)) {
        if (hostname.includes(pattern) || fullUrl.includes(pattern)) {
          category = cat;
          break;
        }
      }

      // Fallback: group by top-level domain
      if (category === 'Other') {
        const parts = hostname.replace('www.', '').split('.');
        const domain = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
        category = `Other/${capitalize(domain)}`;
      }
    } catch {
      category = 'Other/Misc';
    }

    // Enforce max 2 levels deep
    const catParts = category.split('/');
    if (catParts.length > 2) {
      category = catParts.slice(0, 2).join('/');
    }

    if (!categorized[category]) categorized[category] = [];
    categorized[category].push({
      title: item.title,
      url: item.url,
      visits: item.visits,
      bookmarkId: item.bookmarkId,
      status: item.bookmarkId ? 'moved' : 'new',
      _dupeBookmarkIds: item._dupeBookmarkIds || [],
    });
  }

  // If a subcategory has only 1 item, merge up to parent
  const merged = {};
  for (const [cat, catItems] of Object.entries(categorized)) {
    const parts = cat.split('/');
    if (parts.length === 2 && catItems.length === 1) {
      const parent = parts[0];
      if (!merged[parent]) merged[parent] = [];
      merged[parent].push(...catItems);
    } else {
      if (!merged[cat]) merged[cat] = [];
      merged[cat].push(...catItems);
    }
  }

  return merged;
}

function renderOrgTree() {
  const container = $('#org-tree');
  container.innerHTML = '';

  if (!state.orgPlan) return;

  // Quick Access folder
  const quickDiv = document.createElement('div');
  quickDiv.innerHTML = `<div class="tree-folder tree-new">Quick Access (${state.orgPlan.quickAccess.length} items)</div>`;
  const quickList = document.createElement('div');
  quickList.className = 'tree-indent';
  for (const item of state.orgPlan.quickAccess) {
    const cls = item.status === 'new' ? 'tree-new' : 'tree-moved';
    quickList.innerHTML += `<div class="tree-item ${cls}" title="${esc(item.url)}">${esc(item.title)} <small>(${item.visits} visits)</small></div>`;
  }
  quickDiv.appendChild(quickList);
  container.appendChild(quickDiv);

  // Category folders
  const sortedCats = Object.keys(state.orgPlan.categories).sort();
  for (const cat of sortedCats) {
    const catItems = state.orgPlan.categories[cat];
    const parts = cat.split('/');

    const catDiv = document.createElement('div');
    if (parts.length === 1) {
      catDiv.innerHTML = `<div class="tree-folder tree-new">${esc(parts[0])} (${catItems.length})</div>`;
    } else {
      catDiv.innerHTML = `<div class="tree-folder tree-new">${esc(parts[0])}</div>`;
      catDiv.innerHTML += `<div class="tree-indent"><div class="tree-folder tree-new">${esc(parts[1])} (${catItems.length})</div></div>`;
    }

    const listDiv = document.createElement('div');
    listDiv.className = parts.length === 2 ? 'tree-indent tree-indent' : 'tree-indent';
    if (parts.length === 2) listDiv.style.paddingLeft = '40px';

    for (const item of catItems) {
      const cls = item.status === 'new' ? 'tree-new' : 'tree-moved';
      listDiv.innerHTML += `<div class="tree-item ${cls}" title="${esc(item.url)}">${esc(item.title)}</div>`;
    }
    catDiv.appendChild(listDiv);
    container.appendChild(catDiv);
  }

  // Duplicates to remove
  if (state.orgPlan.duplicatesToRemove.length > 0) {
    const dupeDiv = document.createElement('div');
    dupeDiv.innerHTML = `<div class="tree-folder">Duplicates to Remove (${state.orgPlan.duplicatesToRemove.length})</div>`;
    const dupeList = document.createElement('div');
    dupeList.className = 'tree-indent';
    for (const d of state.orgPlan.duplicatesToRemove) {
      dupeList.innerHTML += `<div class="tree-item tree-removed" title="${esc(d.url)}">${esc(d.title)}</div>`;
    }
    dupeDiv.appendChild(dupeList);
    container.appendChild(dupeDiv);
  }
}

// ============================================================
// Step 4: Apply
// ============================================================
$('#btn-backup').addEventListener('click', async () => {
  // Generate Netscape bookmark HTML format for Chrome import
  const html = generateBookmarkHTML(state.bookmarkTree);
  downloadFile(html, 'bookmarks-backup.html', 'text/html');
  state.backupDone = true;
  state.snapshotTree = state.bookmarkTree;
  $('#backup-status').textContent = 'Backup downloaded.';
  $('#btn-apply').disabled = false;
});

$('#btn-apply').addEventListener('click', async () => {
  if (!state.backupDone) {
    $('#apply-status').textContent = 'Please download a backup first.';
    return;
  }
  if (!state.orgPlan) {
    $('#apply-status').textContent = 'No organization plan generated.';
    return;
  }

  $('#btn-apply').disabled = true;
  $('#apply-status').textContent = 'Applying changes...';

  // Build the execution plan for the background script
  const execPlan = buildExecutionPlan(state.orgPlan);
  const result = await sendMsg({ action: 'applyOrganization', plan: execPlan });

  if (result.ok) {
    $('#apply-status').textContent = '';
    show($('#apply-done'));
    show($('#btn-undo'));
  } else {
    $('#apply-status').textContent = 'Error: ' + result.error;
    $('#btn-apply').disabled = false;
  }
});

$('#btn-undo').addEventListener('click', async () => {
  if (!state.snapshotTree) {
    $('#undo-status').textContent = 'No snapshot available. Import the backup HTML manually.';
    return;
  }
  $('#btn-undo').disabled = true;
  $('#undo-status').textContent = 'Restoring bookmarks...';

  const result = await sendMsg({ action: 'undoOrganization', snapshot: state.snapshotTree });
  if (result.ok) {
    $('#undo-status').textContent = 'Bookmarks restored to pre-apply state!';
    hide($('#apply-done'));
    hide($('#btn-undo'));
    $('#btn-apply').disabled = false;
  } else {
    $('#undo-status').textContent = 'Error: ' + result.error + '. Use backup HTML to restore.';
    $('#btn-undo').disabled = false;
  }
});

function buildExecutionPlan(orgPlan) {
  const plan = { create: [], move: [], remove: [] , removeEmptyFolders: [] };
  let placeholderIdx = 0;

  // Create "Quick Access" folder under Bookmarks Bar (id "1")
  const quickPlaceholder = `__folder_${placeholderIdx++}`;
  plan.create.push({
    title: 'Quick Access',
    parentId: '1',
    placeholder: quickPlaceholder,
  });

  // Move or create quick access items
  for (const item of orgPlan.quickAccess) {
    if (item.bookmarkId) {
      plan.move.push({
        id: item.bookmarkId,
        newParentPlaceholder: quickPlaceholder,
      });
    } else {
      plan.create.push({
        title: item.title,
        url: item.url,
        parentPlaceholder: quickPlaceholder,
      });
    }
  }

  // Create category folders and items
  const parentFolderPlaceholders = {}; // top-level name -> placeholder

  for (const [cat, catItems] of Object.entries(orgPlan.categories)) {
    const parts = cat.split('/');
    const topLevel = parts[0];

    // Create top-level folder if not yet created
    if (!parentFolderPlaceholders[topLevel]) {
      const ph = `__folder_${placeholderIdx++}`;
      plan.create.push({
        title: topLevel,
        parentId: '1',
        placeholder: ph,
      });
      parentFolderPlaceholders[topLevel] = ph;
    }

    let targetPlaceholder = parentFolderPlaceholders[topLevel];

    // Create sub-folder if 2 levels
    if (parts.length === 2) {
      const subKey = cat;
      if (!parentFolderPlaceholders[subKey]) {
        const ph = `__folder_${placeholderIdx++}`;
        plan.create.push({
          title: parts[1],
          parentPlaceholder: parentFolderPlaceholders[topLevel],
          placeholder: ph,
        });
        parentFolderPlaceholders[subKey] = ph;
      }
      targetPlaceholder = parentFolderPlaceholders[subKey];
    }

    for (const item of catItems) {
      if (item.bookmarkId) {
        plan.move.push({
          id: item.bookmarkId,
          newParentPlaceholder: targetPlaceholder,
        });
      } else {
        plan.create.push({
          title: item.title,
          url: item.url,
          parentPlaceholder: targetPlaceholder,
        });
      }
    }
  }

  // Remove duplicates
  for (const d of orgPlan.duplicatesToRemove) {
    plan.remove.push({ id: d.id });
  }

  // Track old folders that might become empty
  for (const folder of state.bookmarkFolders) {
    plan.removeEmptyFolders.push({ id: folder.id });
  }

  return plan;
}

// ============================================================
// Bookmark HTML export (Netscape format for Chrome import)
// ============================================================
function generateBookmarkHTML(tree) {
  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>\n`;

  function walk(nodes, indent) {
    for (const node of nodes) {
      const pad = '    '.repeat(indent);
      if (node.url) {
        const addDate = node.dateAdded ? ` ADD_DATE="${Math.floor(node.dateAdded / 1000)}"` : '';
        html += `${pad}<DT><A HREF="${escHtml(node.url)}"${addDate}>${escHtml(node.title)}</A>\n`;
      } else if (node.title) {
        const addDate = node.dateAdded ? ` ADD_DATE="${Math.floor(node.dateAdded / 1000)}"` : '';
        html += `${pad}<DT><H3${addDate}>${escHtml(node.title)}</H3>\n`;
        html += `${pad}<DL><p>\n`;
        if (node.children) walk(node.children, indent + 1);
        html += `${pad}</DL><p>\n`;
      } else if (node.children) {
        walk(node.children, indent);
      }
    }
  }

  walk(tree, 1);
  html += '</DL><p>\n';
  return html;
}

// ============================================================
// CSV helpers
// ============================================================
function downloadCSV(rows, filename) {
  const csv = rows.map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  downloadFile(csv, filename, 'text/csv');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// Utilities
// ============================================================
function sendMsg(msg) {
  return chrome.runtime.sendMessage(msg);
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Remove trailing slash, fragment, common tracking params
    let normalized = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
    // Remove utm_ params
    const cleanUrl = new URL(normalized);
    for (const key of [...cleanUrl.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'source') {
        cleanUrl.searchParams.delete(key);
      }
    }
    return cleanUrl.origin + cleanUrl.pathname.replace(/\/+$/, '') +
           (cleanUrl.searchParams.toString() ? '?' + cleanUrl.searchParams.toString() : '');
  } catch {
    return url.toLowerCase().trim();
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? u.pathname.substring(0, 30) + '...' : u.pathname;
    return u.hostname + path;
  } catch {
    return url.substring(0, 50);
  }
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function setProgress(id, pct) {
  $(`#${id}`).style.width = `${pct}%`;
}

function setStatus(id, text) {
  $(`#${id}`).textContent = text;
}
