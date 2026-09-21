const heading = document.querySelector('#booking-heading');
const status = document.querySelector('#booking-status');
const detailHeading = document.querySelector('#booking-detail-heading');
const detail = document.querySelector('#booking-detail');
const refresh = document.querySelector('#booking-refresh');
const restart = document.querySelector('#booking-restart');
const picker = document.querySelector('#booking-picker');
const timezoneSelect = document.querySelector('#booking-timezone');
const slotsRoot = document.querySelector('#booking-slots');
const slotsStatus = document.querySelector('#slots-status');
const previousWeek = document.querySelector('#previous-week');
const nextWeek = document.querySelector('#next-week');
const selection = document.querySelector('#booking-selection');
const confirmButton = document.querySelector('#confirm-booking');
const bookingError = document.querySelector('#booking-error');
const ref = new URLSearchParams(location.search).get('ref') || '';
let loading = false;
let week = 0;
let slotRequest = 0;
let selectedSlot = '';
let bookingAttempt = null;
let awaitingVerification = false;
let confirmed = false;
let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DAY = 86400000;
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function formatted(date, options) { return new Intl.DateTimeFormat(undefined, { timeZone: timezone, ...options }).format(new Date(date)); }
function fullTime(date) { return formatted(date, { dateStyle: 'full', timeStyle: 'short' }) + ' · ' + timezone; }
function showError(message) { bookingError.textContent = message; bookingError.hidden = false; }
function lockSelection(locked) {
  timezoneSelect.disabled = locked;
  previousWeek.disabled = locked || week === 0;
  nextWeek.disabled = locked || week === 3;
  slotsRoot.querySelectorAll('button').forEach(button => { button.disabled = locked; });
}
function setupTimezones() {
  let zones;
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { zones = ['UTC', 'America/Toronto', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Singapore', 'Australia/Sydney']; }
  timezoneSelect.innerHTML = [...new Set([timezone, 'UTC', ...zones])].map(zone => `<option value="${escapeHtml(zone)}">${escapeHtml(zone.replace(/_/g, ' '))}</option>`).join('');
  timezoneSelect.value = timezone;
}
async function loadSlots() {
  if (awaitingVerification || confirmed) return;
  const request = ++slotRequest;
  selectedSlot = '';
  bookingAttempt = null;
  selection.hidden = true;
  bookingError.hidden = true;
  slotsRoot.innerHTML = '';
  slotsStatus.textContent = 'Loading available times…';
  const startDate = Date.now() + week * 7 * DAY;
  const endDate = startDate + 7 * DAY;
  document.querySelector('#booking-range').textContent = formatted(startDate, { month: 'short', day: 'numeric' }) + ' – ' + formatted(endDate, { month: 'short', day: 'numeric' });
  lockSelection(false);
  try {
    const query = new URLSearchParams({ ref, startDate: String(startDate), endDate: String(endDate), timezone });
    const response = await fetch('/api/booking-slots?' + query, { cache: 'no-store', credentials: 'same-origin' });
    const result = await response.json().catch(() => ({}));
    if (request !== slotRequest) return;
    if (!response.ok || !result.ok || !Array.isArray(result.slots)) throw new Error('unavailable');
    const slots = [...new Set(result.slots)].filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()).sort((a, b) => Date.parse(a) - Date.parse(b));
    const groups = new Map();
    for (const value of slots) {
      const day = formatted(value, { weekday: 'long', month: 'long', day: 'numeric' });
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(value);
    }
    slotsRoot.innerHTML = [...groups].map(([day, values]) => `<section class="slot-day"><h3>${escapeHtml(day)}</h3><div>${values.map(value => `<button type="button" class="slot-button" data-slot="${escapeHtml(value)}" aria-pressed="false" aria-label="${escapeHtml(fullTime(value))}">${escapeHtml(formatted(value, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }))}</button>`).join('')}</div></section>`).join('');
    slotsStatus.textContent = slots.length ? 'Select an available time, then confirm below.' : 'No times are available in this week. Try another week or check again later.';
  } catch (_) {
    if (request === slotRequest) slotsStatus.textContent = 'We couldn’t load available times. Use “Check again” to retry, or try another week.';
  }
}
function showConfirmed(startTime) {
  confirmed = true;
  heading.textContent = 'Your call is booked.';
  status.textContent = fullTime(startTime);
  detailHeading.textContent = 'We look forward to meeting you.';
  detail.textContent = 'Your appointment is confirmed. Keep this time available and watch for the meeting details from School of Gains.';
  picker.hidden = refresh.hidden = true;
}
function restoreExisting(existing) {
  if (!existing || !Number.isFinite(Date.parse(existing.startTime))) return false;
  if (existing.state === 'confirmed') { showConfirmed(existing.startTime); return true; }
  if (['cancelled', 'invalid'].includes(existing.state)) {
    // Cancellation releases the server intent lock; a new choice needs a new ID.
    bookingAttempt = null;
    selectedSlot = null;
    awaitingVerification = false;
    heading.textContent = 'Your previous appointment is no longer booked.';
    status.textContent = 'You can choose another available time below when scheduling is available.';
    return false;
  }
  if (['showed', 'noshow'].includes(existing.state)) {
    heading.textContent = existing.state === 'showed' ? 'Your appointment has taken place.' : existing.state === 'noshow' ? 'Your appointment was marked as missed.' : 'Your appointment is no longer booked.';
    status.textContent = fullTime(existing.startTime);
    detailHeading.textContent = 'Contact the School of Gains sales team.';
    detail.textContent = 'Our team can help with the next step or arrange another conversation.';
    picker.hidden = true;
    return true;
  }
  if (!['pending', 'uncertain'].includes(existing.state)) return false;
  detailHeading.textContent = 'An appointment request is being checked.';
  detail.textContent = 'Please do not make a second booking while this request is being verified.';
  if (existing.canRetry === true) {
    selectedSlot = existing.startTime;
    bookingAttempt = { ref, bookingId: existing.bookingId, startTime: existing.startTime, timezone: existing.timezone };
    awaitingVerification = true;
    picker.hidden = false;
    setupTimezones();
    slotsStatus.textContent = 'Your previous request is being checked.';
    document.querySelector('#selected-time').textContent = fullTime(selectedSlot);
    selection.hidden = false;
    confirmButton.textContent = 'Check confirmation';
    lockSelection(true);
  } else {
    picker.hidden = true;
    detail.textContent = 'An appointment request already exists for this sales conversation. Please contact the School of Gains sales team before making another booking.';
  }
  return true;
}
async function check() {
  if (loading || confirmed) return;
  if (awaitingVerification) { await confirm(); return; }
  if (!/^[A-Za-z0-9_.-]{20,2048}$/.test(ref)) {
    heading.textContent = 'Start with your application.';
    status.textContent = 'A valid application link is needed to continue.';
    detailHeading.textContent = 'Tell us about yourself first.';
    detail.textContent = 'Complete the short application so our team can prepare for your conversation.';
    restart.hidden = false;
    return;
  }
  loading = true;
  refresh.disabled = true;
  try {
    const response = await fetch('/api/booking-context?ref=' + encodeURIComponent(ref), { cache: 'no-store', credentials: 'same-origin' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      picker.hidden = true;
      if ([400, 401, 403, 404, 410].includes(response.status)) {
        heading.textContent = 'This link is no longer available.';
        status.textContent = 'We could not verify this application link.';
        detailHeading.textContent = 'Your link may have expired.';
        detail.textContent = 'If you just submitted an application, return to that form and retry to retrieve your booking link. An expired link does not mean your application was deleted.';
      } else throw new Error('unavailable');
    } else {
      heading.textContent = 'Application received.';
      status.textContent = 'Thank you for sharing your goals. Your application has been saved.';
      if (restoreExisting(result.existingBooking)) return;
      if (result.bookingEnabled === true) {
        detailHeading.textContent = 'Choose your conversation time.';
        detail.textContent = 'Pick an available time below. No appointment is booked until you confirm and see your confirmation.';
        picker.hidden = false;
        if (!timezoneSelect.innerHTML) setupTimezones();
        await loadSlots();
      } else {
        picker.hidden = true;
        detailHeading.textContent = result.reason === 'sales_review_required' ? 'Please contact our sales team.' : 'Scheduling is not available yet.';
        detail.textContent = result.reason === 'sales_review_required' ? 'Our team needs to review your sales conversation before another appointment can be booked.' : 'Online scheduling is still being set up. No appointment has been booked. You can check again here when scheduling becomes available.';
      }
    }
  } catch (_) {
    picker.hidden = true;
    heading.textContent = 'We couldn’t check your application.';
    status.textContent = 'The connection is temporarily unavailable.';
    detailHeading.textContent = 'Please try again shortly.';
    detail.textContent = 'No appointment has been booked by this page. Checking again will not submit another application.';
  } finally {
    loading = false;
    refresh.hidden = confirmed;
    refresh.disabled = false;
  }
}
async function confirm() {
  if (loading || confirmed || !selectedSlot) return;
  loading = true;
  awaitingVerification = true;
  bookingAttempt ||= { ref, bookingId: crypto.randomUUID(), startTime: selectedSlot, timezone };
  lockSelection(true);
  confirmButton.disabled = refresh.disabled = true;
  confirmButton.textContent = 'Checking your appointment…';
  bookingError.hidden = true;
  try {
    const response = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(bookingAttempt) });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.ok && result.booked === true && typeof result.appointmentId === 'string' && Number.isFinite(Date.parse(result.startTime))) {
      showConfirmed(result.startTime);
      return;
    }
    if (response.status === 409 && ['slot_unavailable', 'choose_another_slot'].includes(result.error)) {
      awaitingVerification = false;
      bookingAttempt = null;
      await loadSlots();
      showError('That time is no longer available. Please select another time.');
      return;
    }
    if (response.status === 409 && ['booking_already_in_progress', 'appointment_already_exists'].includes(result.error)) {
      showError('An appointment already exists or is being processed for this application. Please contact the School of Gains sales team before making another booking.');
      confirmButton.hidden = true;
      return;
    }
    // A timeout or pending result may already have created a provider appointment.
    // Keep the same attempt and slot; never offer a second booking as a retry.
    showError('We’re still checking whether your appointment was confirmed. Select “Check confirmation” to check the same request. Please don’t make a second booking.');
  } catch (_) {
    showError('The connection was interrupted while confirming. Select “Check confirmation” to check the same request. Please don’t make a second booking.');
  } finally {
    loading = false;
    confirmButton.disabled = refresh.disabled = false;
    confirmButton.textContent = awaitingVerification ? 'Check confirmation' : 'Confirm appointment';
  }
}
slotsRoot.addEventListener('click', event => {
  const button = event.target.closest('[data-slot]');
  if (!button || awaitingVerification || loading || confirmed) return;
  selectedSlot = button.dataset.slot;
  bookingAttempt = null;
  slotsRoot.querySelectorAll('[data-slot]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  document.querySelector('#selected-time').textContent = fullTime(selectedSlot);
  selection.hidden = false;
  bookingError.hidden = true;
  confirmButton.hidden = false;
});
timezoneSelect.addEventListener('change', () => { if (!awaitingVerification) { timezone = timezoneSelect.value; loadSlots(); } });
previousWeek.addEventListener('click', () => { if (week > 0 && !awaitingVerification) { week--; loadSlots(); } });
nextWeek.addEventListener('click', () => { if (week < 3 && !awaitingVerification) { week++; loadSlots(); } });
confirmButton.addEventListener('click', confirm);
refresh.addEventListener('click', check);
check();
