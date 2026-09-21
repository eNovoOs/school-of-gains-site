import { QUIZ_VERSION, QUESTIONS } from './questions.js';

const form = document.querySelector('#application-form');
const panelsRoot = document.querySelector('#quiz-panels');
const errorBox = document.querySelector('#form-error');
const next = document.querySelector('#next');
const previous = document.querySelector('#previous');
const steps = ['About you', 'Your goals', 'Your learning', 'Your call', 'Review & submit'];
const submissionId = crypto.randomUUID();
let step = 0;
let busy = false;
let started = false;
const fallbackJourneyId = crypto.randomUUID();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function question(key, compact = false) {
  const q = QUESTIONS[key];
  return `<fieldset data-question="${key}"><legend>${q.label}${q.multiple ? '<small class="help"> Select all that apply.</small>' : ''}</legend><div class="options${compact ? ' options-inline' : ''}">${q.options.map(([value, label]) => `<label class="option"><input type="${q.multiple ? 'checkbox' : 'radio'}" name="${key}" value="${value}"><span>${label}</span></label>`).join('')}</div></fieldset>`;
}
panelsRoot.innerHTML = `
  <section class="quiz-panel" data-step="0"><h2 id="quiz-heading" tabindex="-1">First, a little about you.</h2><p class="help">Use the same email address when you book your call.</p><div class="field-grid"><label class="field"><span>First name</span><input name="firstName" autocomplete="given-name" required maxlength="80"></label><label class="field"><span>Last name</span><input name="lastName" autocomplete="family-name" required maxlength="80"></label></div><label class="field"><span>Email address</span><input name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254"></label><label class="field"><span>Phone number</span><input name="phone" type="tel" autocomplete="tel" inputmode="tel" required maxlength="30" placeholder="+1 555 123 4567" aria-describedby="phone-help"><small id="phone-help">Include your country code, starting with +.</small></label></section>
  <section class="quiz-panel" data-step="1" hidden><h2 tabindex="-1">What brings you here?</h2><p class="help">Help us understand where you want to go.</p>${question('ageRange', true)}${question('goals')}</section>
  <section class="quiz-panel" data-step="2" hidden><h2 tabindex="-1">Make room for learning.</h2><p class="help">Choose what feels realistic for you right now. These answers won't prevent you from booking.</p>${question('weeklyTime')}${question('educationBudget')}</section>
  <section class="quiz-panel" data-step="3" hidden><h2 tabindex="-1">Prepare for a useful call.</h2><p class="help">You can choose a time after submitting your application.</p>${question('attendance')}<label class="field"><span>Anything else you'd like us to know? <span class="muted">(Optional)</span></span><textarea name="notes" rows="4" maxlength="2000" placeholder="Your questions, learning goals, or where you feel stuck…"></textarea></label></section>
  <section class="quiz-panel" data-step="4" hidden><h2 tabindex="-1">Ready to take the next step?</h2><p class="help">Review your details, then submit to choose a call time.</p><dl class="review-list" id="review-list"></dl><label class="consent"><input type="checkbox" name="privacy" required><span>I have read the <a href="/privacy-page" target="_blank" rel="noopener">Privacy Policy</a> and agree that School of Gains may use these details to handle my application and contact me about it.</span></label><label class="consent"><input type="checkbox" name="marketing"><span>I'd also like to receive School of Gains learning resources and offers by email. Optional; you can unsubscribe at any time.</span></label></section>`;

function context() {
  const captured = window.SOGAttribution?.get?.() || {};
  return {
    journeyId: captured.journeyId || window.SOGAttribution?.journeyId || fallbackJourneyId,
    attribution: captured.firstTouch || captured.latestTouch
      ? { firstTouch: captured.firstTouch, latestTouch: captured.latestTouch }
      : {},
  };
}
function recordStart() {
  if (started) return;
  started = true;
  window.SOGAttribution?.track?.('quiz_started');
}
form.addEventListener('input', recordStart, { once: true });

function showError(message, field) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  field?.focus();
}
function readAnswers() {
  const data = new FormData(form);
  return {
    ageRange: data.get('ageRange'), goals: data.getAll('goals'),
    weeklyTime: data.get('weeklyTime'), educationBudget: data.get('educationBudget'),
    attendance: data.get('attendance'), notes: String(data.get('notes') || '').trim(),
  };
}
function contact() {
  const data = new FormData(form);
  return {
    firstName: String(data.get('firstName') || '').trim(),
    lastName: String(data.get('lastName') || '').trim(),
    email: String(data.get('email') || '').trim(),
    phone: String(data.get('phone') || '').replace(/[\s().-]/g, ''),
  };
}
function validateCurrent() {
  const panel = document.querySelector(`[data-step="${step}"]`);
  for (const input of panel.querySelectorAll('input[required],textarea[required]')) {
    if (input.type !== 'checkbox') input.value = input.value.trim();
    if (!input.checkValidity()) {
      showError(input.type === 'checkbox' ? 'Please acknowledge the Privacy Policy to submit your application.' : `Please enter a valid ${input.name.replace(/([A-Z])/g, ' $1').toLowerCase()}.`, input);
      return false;
    }
  }
  if (step === 0 && !/^\+[1-9]\d{7,14}$/.test(contact().phone)) {
    showError('Please enter your phone number with a country code, for example +1 555 123 4567.', form.elements.phone);
    return false;
  }
  for (const fieldset of panel.querySelectorAll('[data-question]')) {
    if (!fieldset.querySelector('input:checked')) {
      showError('Please choose an answer for each question to continue.', fieldset.querySelector('input'));
      return false;
    }
  }
  return true;
}
function label(key, value) {
  return QUESTIONS[key].options.find(option => option[0] === value)?.[1] || value;
}
function renderReview() {
  const c = contact();
  const a = readAnswers();
  const rows = [
    ['Name', `${c.firstName} ${c.lastName}`], ['Email', c.email], ['Phone', c.phone],
    ['Age', label('ageRange', a.ageRange)], ['Goals', a.goals.map(value => label('goals', value)).join('; ')],
    ['Learning', label('weeklyTime', a.weeklyTime)], ['Budget', label('educationBudget', a.educationBudget)],
    ['Call', label('attendance', a.attendance)],
  ];
  if (a.notes) rows.push(['Notes', a.notes]);
  document.querySelector('#review-list').innerHTML = rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
}
function showStep() {
  document.querySelectorAll('.quiz-panel').forEach((panel, index) => {
    panel.hidden = index !== step;
    const heading = panel.querySelector('h2');
    heading.id = index === step ? 'quiz-heading' : '';
  });
  document.querySelector('#step-label').textContent = `Step ${step + 1} of ${steps.length}`;
  document.querySelector('#step-topic').textContent = steps[step];
  document.querySelector('#quiz-progress').value = step + 1;
  previous.hidden = step === 0;
  next.innerHTML = step === steps.length - 1 ? 'Submit application <span aria-hidden="true">↗</span>' : 'Continue <span aria-hidden="true">→</span>';
  errorBox.hidden = true;
  if (step === 4) renderReview();
  document.querySelector('#quiz-heading').focus({ preventScroll: true });
  if (window.innerWidth <= 680) document.querySelector('.quiz-card').scrollIntoView({ block: 'start', behavior: 'instant' });
}
previous.addEventListener('click', () => { if (!busy && step > 0) { step--; showStep(); } });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !validateCurrent()) return;
  if (step < steps.length - 1) { step++; showStep(); return; }
  busy = true;
  next.disabled = previous.disabled = true;
  next.textContent = 'Submitting…';
  errorBox.hidden = true;
  const { journeyId, attribution } = context();
  try {
    const response = await fetch('/api/applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId, journeyId, quizVersion: QUIZ_VERSION, contact: contact(), answers: readAnswers(), consent: { privacy: form.elements.privacy.checked, marketing: form.elements.marketing.checked }, attribution, website: form.elements.website.value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(response.status === 503 ? 'Applications are temporarily unavailable. Your answers are still here; please try again shortly.' : 'We couldn’t confirm your application was saved. Please try again. Retrying will not duplicate your application.');
    const destination = new URL(result.bookingPath, location.origin);
    if (destination.origin !== location.origin || destination.pathname !== '/book' || !destination.searchParams.get('ref')) {
      throw new Error('Your application was received, but we couldn’t open the booking page. Please try again to retrieve your booking link.');
    }
    location.assign(destination.href);
  } catch (error) {
    showError(error.message || 'We couldn’t connect. Your answers are still here; please try again.');
    busy = false;
    next.disabled = previous.disabled = false;
    next.innerHTML = 'Submit application <span aria-hidden="true">↗</span>';
  }
});
