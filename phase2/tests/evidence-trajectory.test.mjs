import test from 'node:test';
import assert from 'node:assert/strict';
import {observeEvidenceTrajectory,resetEvidenceTrajectoryForTests} from '../core/evidence-trajectory.mjs';

function alert(symbol='TESTUSDT',radar='EARLY_MOVE_RADAR',stamp=0,delta=0){
  return {
    symbol,radar,detected_at:stamp,
    components:{
      structure_score:62+delta,
      flow_score:64+delta,
      volume:66+delta,
      trades:65+delta,
      momentum:63+delta,
      relative_strength:61+delta,
      compression_score:67+delta,
      liquidity:80,
      acceleration:70+delta
    },
    liquidity_quality:80,
    pre_breakout_fingerprint:{
      structure_score:62+delta,
      pressure_score:64+delta,
      relative_strength_score:61+delta,
      compression_score:67+delta,
      anti_chase_score:85
    }
  };
}

test('evidence trajectory detects a building/igniting sequence',()=>{
  resetEvidenceTrajectoryForTests();
  assert.equal(observeEvidenceTrajectory(alert('UPUSDT','EARLY_MOVE_RADAR',1000,0)).persistence,1);
  assert.equal(observeEvidenceTrajectory(alert('UPUSDT','EARLY_MOVE_RADAR',70000,5)).persistence,2);
  const third=observeEvidenceTrajectory(alert('UPUSDT','EARLY_MOVE_RADAR',140000,11));
  assert.equal(third.persistence,3);
  assert.ok(third.improving_domains>=4);
  assert.ok(['BUILDING','IGNITING'].includes(third.regime));
  assert.ok(third.convergence>=62);
});

test('evidence trajectory penalizes deterioration',()=>{
  resetEvidenceTrajectoryForTests();
  observeEvidenceTrajectory(alert('DOWNUSDT','EARLY_MOVE_RADAR',1000,12));
  observeEvidenceTrajectory(alert('DOWNUSDT','EARLY_MOVE_RADAR',70000,2));
  const third=observeEvidenceTrajectory(alert('DOWNUSDT','EARLY_MOVE_RADAR',140000,-12));
  assert.equal(third.persistence,3);
  assert.equal(third.regime,'DETERIORATING');
  assert.ok(third.degrading_domains>=4);
});

test('trajectory is idempotent for repeated snapshots',()=>{
  resetEvidenceTrajectoryForTests();
  const a=alert('IDEMUSDT','EARLY_MOVE_RADAR',1000,8);
  const first=observeEvidenceTrajectory(a,1000);
  const second=observeEvidenceTrajectory(a,5000);
  assert.equal(first.persistence,1);
  assert.equal(second.persistence,1);
});
