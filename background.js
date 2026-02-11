// Background service worker — handles Chrome API calls on behalf of popup

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scanTabs') {
    handleScanTabs().then(sendResponse);
    return true;
  }
  if (msg.action === 'scanBookmarks') {
    handleScanBookmarks().then(sendResponse);
    return true;
  }
  if (msg.action === 'getVisitCounts') {
    handleGetVisitCounts(msg.urls).then(sendResponse);
    return true;
  }
  if (msg.action === 'getSummary') {
    handleGetSummary(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'applyOrganization') {
    handleApplyOrganization(msg.plan).then(sendResponse);
    return true;
  }
  if (msg.action === 'undoOrganization') {
    handleUndoOrganization(msg.snapshot).then(sendResponse);
    return true;
  }
});

// --- Scan all open tabs with their tab group info ---
async function handleScanTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    let groups = {};
    try {
      const tabGroups = await chrome.tabGroups.query({});
      for (const g of tabGroups) {
        groups[g.id] = { title: g.title || 'Untitled Group', color: g.color };
      }
    } catch (e) {
      // tabGroups API may not be available in older Chrome
    }

    const results = tabs.map(t => ({
      id: t.id,
      title: t.title || '',
      url: t.url || '',
      groupId: t.groupId,
      groupName: t.groupId > 0 ? (groups[t.groupId]?.title || 'Group') : '',
      groupColor: t.groupId > 0 ? (groups[t.groupId]?.color || '') : '',
      favIconUrl: t.favIconUrl || '',
    }));

    return { ok: true, tabs: results, groups };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Scan all bookmarks recursively ---
async function handleScanBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = [];
    const folders = [];

    function walk(nodes, path) {
      for (const node of nodes) {
        if (node.url) {
          bookmarks.push({
            id: node.id,
            title: node.title || '',
            url: node.url,
            folder: path,
            dateAdded: node.dateAdded,
          });
        } else {
          const folderPath = path ? `${path}/${node.title}` : node.title;
          if (node.title) {
            folders.push({ id: node.id, title: node.title, path: folderPath });
          }
          if (node.children) {
            walk(node.children, node.title ? folderPath : path);
          }
        }
      }
    }

    walk(tree, '');
    return { ok: true, bookmarks, folders, tree };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Get visit counts from history for a list of URLs ---
async function handleGetVisitCounts(urls) {
  try {
    const counts = {};
    // Process in batches to avoid overwhelming the API
    const batchSize = 20;
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      const promises = batch.map(async (url) => {
        try {
          const visits = await chrome.history.getVisits({ url });
          counts[url] = visits.length;
        } catch {
          counts[url] = 0;
        }
      });
      await Promise.all(promises);
    }
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Extract a summary from a tab using content script injection ---
async function handleGetSummary(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageSummary,
    });
    const summary = results?.[0]?.result || '';
    return { ok: true, summary };
  } catch (e) {
    // Likely a chrome:// or extension page — can't inject
    return { ok: true, summary: '' };
  }
}

// This function runs in the context of the web page
function extractPageSummary() {
  // Priority: meta description > og:description > first <p> text
  const meta = document.querySelector('meta[name="description"]');
  if (meta?.content) return meta.content.trim().substring(0, 200);

  const og = document.querySelector('meta[property="og:description"]');
  if (og?.content) return og.content.trim().substring(0, 200);

  const paragraphs = document.querySelectorAll('p');
  for (const p of paragraphs) {
    const text = p.textContent?.trim();
    if (text && text.length > 30) {
      return text.substring(0, 200);
    }
  }

  return document.title || '';
}

// --- Apply a bookmark reorganization plan ---
async function handleApplyOrganization(plan) {
  try {
    // plan.create = [{ title, parentId, url? }] — folders/bookmarks to create
    // plan.move = [{ id, newParentId, index? }] — bookmarks to move
    // plan.remove = [{ id }] — duplicate bookmarks to remove

    const createdFolders = {}; // placeholder name -> real id

    // 1. Create new folders first
    for (const item of (plan.create || [])) {
      if (!item.url) {
        // It's a folder
        const parentId = createdFolders[item.parentPlaceholder] || item.parentId;
        const created = await chrome.bookmarks.create({
          title: item.title,
          parentId: parentId,
        });
        createdFolders[item.placeholder] = created.id;
      }
    }

    // 2. Move bookmarks
    for (const item of (plan.move || [])) {
      const newParentId = createdFolders[item.newParentPlaceholder] || item.newParentId;
      await chrome.bookmarks.move(item.id, { parentId: newParentId });
    }

    // 3. Create new bookmarks (from tabs not yet bookmarked)
    for (const item of (plan.create || [])) {
      if (item.url) {
        const parentId = createdFolders[item.parentPlaceholder] || item.parentId;
        await chrome.bookmarks.create({
          title: item.title,
          url: item.url,
          parentId: parentId,
        });
      }
    }

    // 4. Remove duplicates
    for (const item of (plan.remove || [])) {
      try {
        await chrome.bookmarks.remove(item.id);
      } catch {
        // Already removed or doesn't exist
      }
    }

    // 5. Clean up empty folders left behind
    for (const item of (plan.removeEmptyFolders || [])) {
      try {
        const children = await chrome.bookmarks.getChildren(item.id);
        if (children.length === 0) {
          await chrome.bookmarks.removeTree(item.id);
        }
      } catch {
        // Ignore
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Undo by restoring from snapshot ---
async function handleUndoOrganization(snapshot) {
  try {
    // Get current bookmarks tree
    const currentTree = await chrome.bookmarks.getTree();

    // Remove all current bookmarks (except root nodes which can't be removed)
    async function removeAll(nodes) {
      for (const node of nodes) {
        if (node.id === '0') {
          if (node.children) await removeAll(node.children);
          continue;
        }
        // Root bookmark bar (1), Other (2), Mobile (3) can't be removed
        if (['1', '2', '3'].includes(node.id)) {
          // Remove children instead
          if (node.children) {
            for (const child of node.children) {
              try {
                if (child.url) {
                  await chrome.bookmarks.remove(child.id);
                } else {
                  await chrome.bookmarks.removeTree(child.id);
                }
              } catch { /* ignore */ }
            }
          }
          continue;
        }
      }
    }

    await removeAll(currentTree);

    // Recreate from snapshot
    async function recreate(nodes, parentId) {
      for (const node of nodes) {
        if (['0', '1', '2', '3'].includes(node.id)) {
          if (node.children) {
            await recreate(node.children, node.id);
          }
          continue;
        }
        if (node.url) {
          await chrome.bookmarks.create({
            parentId,
            title: node.title,
            url: node.url,
          });
        } else {
          const folder = await chrome.bookmarks.create({
            parentId,
            title: node.title,
          });
          if (node.children) {
            await recreate(node.children, folder.id);
          }
        }
      }
    }

    await recreate(snapshot, '0');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
