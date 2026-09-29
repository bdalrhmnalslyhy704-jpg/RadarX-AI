export const EVENT_CLASS=Object.freeze({
  TEST_PUSH_ONLY:'TEST_PUSH_ONLY',
  TEST_FIXTURE:'TEST_FIXTURE',
  LIVE_MARKET_SIGNAL:'LIVE_MARKET_SIGNAL'
});

export function marketEventClass(source){
  return String(source||'').toUpperCase()==='TEST_FIXTURE'
    ? EVENT_CLASS.TEST_FIXTURE
    : EVENT_CLASS.LIVE_MARKET_SIGNAL;
}