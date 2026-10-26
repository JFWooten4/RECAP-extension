import {
  getTabById,
  saveOptionsAndUpdateToolbar,
  setDefaultOptions,
  updateToolbarButton,
} from './utils/toolbar_button.js';
import {
  chooseVariant,
  injectContentScript,
  showNotificationTab,
  getAndStoreMetaData,
  overwriteSubmitMethod,
  getDocumentDataFromDownloadModal,
} from './utils/background.js';
import { handleBackgroundFetch } from './utils/background_fetch.js';
import { handleBackgroundNotification } from './utils/background_notifier.js';
import { getDocumentURL } from './utils/acms_api.js';
import './spend_tracker.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.message === 'recordPacerSpend') {
    if (!sender.tab || !sender.url || !/^https:\/\/(?:[\w.-]+\.uscourts\.gov|[\w.-]+\.azurewebsites\.us)\//i.test(sender.url)) {
      sendResponse({error: 'Untrusted PACER origin'});
      return false;
    }
    RECAPSpend.record(chrome.storage.local, msg.transaction)
      .then(saved => sendResponse({saved}))
      .catch(error => sendResponse({error: error.message}));
    return true;
  }
  if (msg.message === 'requestTabId') {
    sendResponse({ tabId: sender.tab.id });
  }
  if (msg.message === 'clearBadge') {
    chrome.storage.local.get('options', function (items) {
      items.options['dismiss_news_badge'] = true;
      saveOptionsAndUpdateToolbar(items.options);
    });
  }
  if (msg.message === 'backgroundFetch') {
    handleBackgroundFetch(msg, sender, sendResponse);
    return true;
  }
  if (msg.message === 'backgroundNotifier') {
    handleBackgroundNotification(msg, sender, sendResponse);
    return true;
  }
  if (msg.message === 'getMetaData') {
    getAndStoreMetaData(msg, sender, sendResponse);
    return true;
  }
  if (msg.message === 'getDocumentDataFromDownloadModal') {
    getDocumentDataFromDownloadModal(msg, sender, sendResponse);
    return true;
  }
  if (msg.message === 'overwriteSubmit') {
    overwriteSubmitMethod(msg, sender, sendResponse);
    return true;
  }
  if (msg.message === 'fetchAcmsDocumentUrl'){
    getDocumentURL(msg, sender, sendResponse);
    return true;
  }
});

chrome.runtime.onInstalled.addListener(setDefaultOptions);
chrome.runtime.onInstalled.addListener(showNotificationTab);
chrome.runtime.onInstalled.addListener(chooseVariant);

// Watches all the tabs so we can update their toolbar buttons on navigation.
chrome.tabs.onUpdated.addListener(async function (tabId, details, tab) {
  updateToolbarButton(tab);
  await injectContentScript(tabId, details.status, tab.url);
});
chrome.tabs.onActivated.addListener(function (activeInfo) {
  getTabById(activeInfo.tabId, updateToolbarButton);
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'popup') {
    port.onDisconnect.addListener(function () {
      chrome.storage.local.get('options', function (items) {
        items.options['dismiss_news_badge'] = true;
        saveOptionsAndUpdateToolbar(items.options);
      });
    });
  }
});
