'use strict';
// Synthetic candidates for the CV stage tests: every name, e-mail, phone number and postcode is invented and obviously fake.
// The PLANTED values are put into CV files and records on purpose, so a test can prove that none of them reaches Jev, the
// shadow log or the disk.

const PLANTED = {
  first: 'Zedediah',
  last: 'Quimbleton',
  email: 'zedediah.quimbleton@example.invalid',
  phone: '07700 900321',
  phoneDigits: '07700900321',
  postcode: 'ZZ9 9ZZ',
  street: '14 Marigold Lane',
  referee: 'Ottoline Farthing',
  refereePhone: '07700 900555',
  canaryEmployer: 'Canary Bistro Group',
  canaryDuty: 'zebra-canary-duty',
};

const NOW = new Date('2026-09-30T12:00:00Z');

function role(title, start, end, extra) {
  return { title, employer: 'Test Kitchen Ltd', start, end, duties: ['prep', 'service'], ...(extra || {}) };
}

function record(roles, extra) {
  return { source: 'caterer', fileType: 'pdf', parseConfidence: 0.9, redactionVerified: true, qualifications: [], skills: [], roles, ...(extra || {}) };
}

/** A plain-text CV in the layout the stub parser reads (the vendored parser reads it too). */
function cvText(roles, opts) {
  const o = opts || {};
  const lines = [
    `${PLANTED.first} ${PLANTED.last}`,
    `${PLANTED.street}, Testville ${PLANTED.postcode}`,
    `Tel ${PLANTED.phone}   ${PLANTED.email}`,
    '',
    'PROFILE',
    'A hard working and reliable person looking for shifts.',
    '',
    'EXPERIENCE',
  ];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = v => {
    if (v === 'present') return 'Present';
    const [y, m] = v.split('-');
    return `${mon[Number(m) - 1]} ${y}`;
  };
  for (const r of roles) {
    lines.push(`${r.title} | ${r.employer || 'Test Kitchen Ltd'} | ${fmt(r.start)} - ${fmt(r.end)}`);
    for (const d of r.duties || ['prep', 'service']) lines.push(`- ${d}`);
    lines.push('');
  }
  lines.push('EDUCATION', 'Level 2 Food Safety', '');
  if (o.references !== false) lines.push('REFERENCES', `${PLANTED.referee}, Head of Kitchen, ${PLANTED.refereePhone}`);
  return lines.join('\n');
}

const KNOWN = {
  names: [`${PLANTED.first} ${PLANTED.last}`, PLANTED.first, PLANTED.last],
  emails: [PLANTED.email],
  phones: [PLANTED.phone],
  postcodes: [PLANTED.postcode],
};

module.exports = { PLANTED, NOW, KNOWN, role, record, cvText };
