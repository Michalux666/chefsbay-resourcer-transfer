'use strict';
// SCENARIO 20 - the role scope TOGETHER WITH the CV stage on (CV_SCREEN=on): the same world as scenario 19 (Caterer and Reed, six searches, the old skip with
// ROLE_SCOPE_LEGACY=off), but the CV stage now really rejects after the unlock and the download. The exact outcomes of the CV stage depend on the fake CV, so the
// assertions of scenario 19 that name a CV outcome are replaced here by the invariants the owner asked for: each (person, title) is screened at most once, no second
// Zoho record, no second charge for the same role, nothing recorded for a title that was not searched. Run as a file of its own by tests/e2e-linux.sh.
process.env.E2E_ROLESCOPE_CV = 'on';
require('./19-rolescope.e2e.js');
