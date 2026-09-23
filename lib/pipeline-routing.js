// GHL entry columns are more detailed than the local appointment lifecycle.
// Keep lifecycle state canonical so reschedules/cancellations cannot strand BOF deals.
const BOOKING_KEYS = new Set(['booked_ads','booked_setter','booked_closer']);
const FOLLOW_UP_KEYS = new Set(['contacted_once','contacted_twice','future_follow_up']);
function stageKey(stages, id) {
  return Object.entries(stages).find(([,value])=>value===id)?.[0];
}
function lifecycleStage(stages, id) {
  const key=stageKey(stages,id);
  return BOOKING_KEYS.has(key)?'booked':FOLLOW_UP_KEYS.has(key)?'follow_up':key;
}
function bookingStage(stages, remoteId, appointment) {
  const current=stageKey(stages,remoteId);
  // Preserve an explicit GHL booking category; UTM updates never replace staff credit.
  if(BOOKING_KEYS.has(current))return current;
  // Only the appointment's verified booking setter is relevant. Cycle ownership,
  // calendar assignedUserId and public query parameters cannot establish credit.
  if(appointment?.booking_setter_id)return 'booked_setter';
  const touch=appointment?.attribution?.latestTouch || {};
  const medium=String(touch.medium || touch.utm_medium || '').trim().toLowerCase();
  if(['cpc','ppc','paid_search','paid_social','paid_video','display'].includes(medium))return 'booked_ads';
  // Provider readback currently has no verified closer-as-booker field. Preserve
  // existing closer BOF above, otherwise use Booked rather than infer the actor.
  return 'booked';
}
function protectsProgress(remoteStage, targetStage) {
  return ['won','lost'].includes(remoteStage) ||
    (['call_held','follow_up'].includes(remoteStage) && ['unbooked','booked','no_show'].includes(targetStage));
}
module.exports={stageKey,lifecycleStage,bookingStage,protectsProgress};
