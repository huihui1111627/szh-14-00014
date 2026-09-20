import assert from "node:assert/strict";
import {
  BEND_LIMIT,
  CORRIDOR_HALF_WIDTH,
  TENSION_LIMIT,
  catenaryGeometry,
  createInitialState,
  forecast,
  stepSimulation,
} from "../src/simulation.js";

{
  const geometry = catenaryGeometry(250, 140, 0, 0.18);
  assert.ok(geometry.length > 250, "suspended length must exceed horizontal lag");
  assert.ok(geometry.length < 330, "baseline suspended length should remain physical");
  assert.ok(geometry.radius > BEND_LIMIT, "baseline radius should be safe");
  assert.ok(geometry.topTension > 20000, "baseline tension should be measurable");
}

{
  let state = createInitialState();
  for (let i = 0; i < 160; i += 1) {
    state = stepSimulation(state, 1, {
      speed: 0.55,
      turnRate: 0,
      payoutRatio: 0.84,
    });
  }
  assert.ok(state.lag < 237, "low payout should shorten lag");
}

{
  const result = forecast(createInitialState(), {
    speed: 3,
    turnRate: 0,
    payoutRatio: 1.18,
  }, 300, 2);
  const tension = result.events.find((event) => event.type === "tension");
  assert.ok(tension, "excess payout and long lag should forecast a tension event");
  assert.ok(tension.value >= TENSION_LIMIT, "tension event must exceed the limit");
  assert.ok(Number.isFinite(tension.position.x), "tension event must include a position");
  assert.ok(tension.time > 0 && tension.time <= 300, "tension event must include ETA");
}

{
  const result = forecast(createInitialState(), {
    speed: 0.55,
    turnRate: 0,
    payoutRatio: 0.82,
  }, 300, 2);
  assert.ok(result.finalState.lag < 225, "slow under-payout should pull the touchdown point closer");
  assert.ok(result.finalState.suspendedLength < 285, "under-payout should shorten suspended cable");
}

{
  const result = forecast(createInitialState(), {
    speed: 0.6,
    turnRate: 0,
    payoutRatio: 0.7,
  }, 300, 2);
  const bend = result.events.find((event) => event.type === "bend");
  assert.ok(bend, "extreme under-payout should forecast a local bend event");
  assert.ok(bend.value < BEND_LIMIT, "bend event must be sharper than the minimum radius");
  assert.ok(bend.position.y > -400, "bend event must carry a touchdown position");
}

{
  const result = forecast(createInitialState(), {
    speed: 2.4,
    turnRate: 7.5,
    payoutRatio: 1.08,
  }, 300, 2);
  const corridor = result.events.find((event) => event.type === "corridor");
  assert.ok(corridor, "hard turn should forecast a corridor event");
  assert.ok(Math.abs(corridor.value) >= CORRIDOR_HALF_WIDTH, "corridor event must exceed boundary");
}

{
  const result = forecast(createInitialState(), {
    speed: 1.55,
    turnRate: 0,
    payoutRatio: 1,
  }, 300, 2);
  const crossing = result.events.find((event) => event.type === "crossing");
  assert.ok(crossing, "route should intersect the existing pipeline");
  assert.ok(crossing.position.x > -300 && crossing.position.y > 100, "crossing should carry coordinates");
}

{
  const first = forecast(createInitialState(), {
    speed: 1.55,
    turnRate: 0,
    payoutRatio: 0.9,
  }, 60, 1);
  const second = forecast(createInitialState(), {
    speed: 1.55,
    turnRate: 0,
    payoutRatio: 1.1,
  }, 60, 1);
  assert.equal(first.tdpPath.length, second.tdpPath.length, "forecast horizon should be deterministic");
  assert.ok(
    Math.abs(first.finalState.lag - second.finalState.lag) > 1,
    "different payout strategies must produce different touchdown geometry",
  );
}

assert.ok(true);
console.log("simulation tests passed");
