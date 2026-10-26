// Check PACER's calendar-quarter waiver window even when the popup is closed.
import '../spend_tracker.js';
import { updateToolbarButton } from './toolbar_button.js';

const ALARM = 'recap-quarter-end-spend-check';
const NOTIFICATION = 'recap-quarter-end-spend-reminder';
const LAST_NOTICE_KEY = 'pacer_spend_last_notice_quarter';
const WISHLIST = 'https://www.courtlistener.com/prayers/top/';
const PACER_STATEMENT = 'https://pacer.psc.uscourts.gov/pscof/manage/stmtView.jsf';
let sequence = Promise.resolve();

async function refreshToolbar() {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  updateToolbarButton(tabs[0]);
}

async function check() {
  const stored = await chrome.storage.local.get([
    RECAPSpend.KEY, RECAPSpend.ADJUSTMENTS_KEY, 'options', LAST_NOTICE_KEY,
  ]);
  const warning = RECAPSpend.endOfQuarterState(
    stored[RECAPSpend.KEY], stored[RECAPSpend.ADJUSTMENTS_KEY] || {});
  await refreshToolbar();
  if (!warning.active || stored.options?.quarterly_spend_reminders === false ||
      stored[LAST_NOTICE_KEY] === warning.quarter) return;

  const amount = RECAPSpend.dollars(warning.remaining);
  const threshold = RECAPSpend.dollars(warning.totals.threshold);
  const hours = Math.ceil(warning.msLeft / (60 * 60 * 1000));
  try {
    await chrome.notifications.create(NOTIFICATION, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/images/icon-128.png'),
      title: 'RECAP: PACER quarter ends soon',
      message: amount + ' remains below the ' + threshold +
        ' quarterly waiver threshold (' + hours + ' hours left). ' +
        'Verify with PACER before requesting more documents. ' +
        'You can also help fulfill the Pray and Pay wishlist.',
      buttons: [
        {title: 'Check PACER statement'},
        {title: 'Free Law wishlist'},
      ],
      priority: 2,
    });
    // Mark only after a successful API call; never repeat within this quarter.
    await chrome.storage.local.set({[LAST_NOTICE_KEY]: warning.quarter});
  } catch (error) {
    console.warn('RECAP: Could not create quarter-end reminder', error);
  }
}

function checkQuarterEnd() {
  // Serialize startup/alarm/storage events to prevent duplicate notifications.
  sequence = sequence.catch(() => {}).then(check);
  return sequence;
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) {
    await chrome.alarms.create(ALARM, {periodInMinutes: 60});
  }
}

function openWishlist(notificationId) {
  if (notificationId === NOTIFICATION) {
    chrome.tabs.create({url: WISHLIST});
  }
}

function openReminderButton(notificationId, buttonIndex) {
  if (notificationId !== NOTIFICATION) return;
  if (buttonIndex === 0) chrome.tabs.create({url: PACER_STATEMENT});
  if (buttonIndex === 1) chrome.tabs.create({url: WISHLIST});
}

export function installQuarterlySpendReminder() {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void checkQuarterEnd();
  });
  chrome.runtime.onStartup.addListener(() => {
    void ensureAlarm();
    void checkQuarterEnd();
  });
  chrome.runtime.onInstalled.addListener(() => {
    void ensureAlarm();
    void checkQuarterEnd();
  });
  chrome.notifications.onClicked.addListener(openWishlist);
  if (chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener(openReminderButton);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' &&
        (changes[RECAPSpend.KEY] || changes[RECAPSpend.ADJUSTMENTS_KEY] ||
         changes.options)) void checkQuarterEnd();
  });
  // Recreate an alarm if an extension update or browser restart removed it.
  void ensureAlarm();
  void checkQuarterEnd();
}
