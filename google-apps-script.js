/**
 * Google Apps Script — Website Assessment Pipeline
 * Receives quiz submissions, scores them, writes to Assessments sheet,
 * generates PDF report, and emails it after 30 minutes.
 *
 * SETUP:
 * 1. Go to https://script.google.com → paste this code
 * 2. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone)
 * 3. Copy URL → paste as APPS_SCRIPT_URL in index.html
 * 4. Create a folder in Drive for temp reports (update REPORT_FOLDER_ID)
 */

var SPREADSHEET_ID = '1k1tPzPyX02NFn8ZtU8VXtUpLzjDiZ1htDsO9hmIAkEs';
var SHEET_LEADS = 'Website Leads';
var SHEET_ASSESSMENTS = 'Website Assessments';
var REPORT_FOLDER_ID = ''; // Optional: Drive folder ID for temp PDF storage

// ═══════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var answers = data.answers || [];

    // 1. Save raw lead
    saveToLeadsSheet_(data, answers);

    // 2. Score the assessment
    var scores = computeScores_(answers);

    // 3. Write to Assessments sheet
    saveToAssessmentsSheet_(data, scores);

    // 4. Schedule PDF + email in 30 minutes
    var payload = JSON.stringify({
      email: data.email || '',
      linkedin: data.linkedin || '',
      phone: data.phone || '',
      contact: data.contact || '',
      scores: scores,
      answers: answers
    });

    // Store payload in PropertiesService keyed by timestamp
    var key = 'report_' + new Date().getTime();
    PropertiesService.getScriptProperties().setProperty(key, payload);

    // Create time-based trigger for 30 minutes from now
    ScriptApp.newTrigger('sendDelayedReport_')
      .timeBased()
      .after(30 * 60 * 1000)
      .create();

    // Store trigger key mapping
    var triggers = ScriptApp.getProjectTriggers();
    var lastTrigger = triggers[triggers.length - 1];
    PropertiesService.getScriptProperties().setProperty(
      'trigger_' + lastTrigger.getUniqueId(), key
    );

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'ok' })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput('Highgate Society lead endpoint is active.');
}

// ═══════════════════════════════════════════════════════════
// DELAYED REPORT SENDER
// ═══════════════════════════════════════════════════════════

function sendDelayedReport_(e) {
  try {
    // Find which payload this trigger is for
    var triggerId = e.triggerUid;
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('trigger_' + triggerId);

    if (!key) {
      Logger.log('No payload key found for trigger ' + triggerId);
      cleanupTrigger_(triggerId);
      return;
    }

    var payload = JSON.parse(props.getProperty(key));
    if (!payload || !payload.email) {
      Logger.log('No payload or email for key ' + key);
      cleanupTrigger_(triggerId);
      props.deleteProperty(key);
      props.deleteProperty('trigger_' + triggerId);
      return;
    }

    // Generate PDF
    var pdfBlob = generateReportPdf_(payload);

    // Send email
    MailApp.sendEmail({
      to: payload.email,
      subject: 'Your AI Readiness Report — Highgate Society',
      htmlBody: buildEmailHtml_(payload),
      attachments: [pdfBlob],
      name: 'Highgate Society'
    });

    Logger.log('Report sent to ' + payload.email);

    // Cleanup
    props.deleteProperty(key);
    props.deleteProperty('trigger_' + triggerId);
    cleanupTrigger_(triggerId);

  } catch (err) {
    Logger.log('sendDelayedReport_ error: ' + err.toString());
  }
}

function cleanupTrigger_(triggerId) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════

/**
 * Website quiz question mapping (0-indexed):
 *  Q0-Q5:   Adaptability (Concern×2, Control×2, Curiosity, Confidence)
 *  Q6-Q9:   Transition Phase (categorical: ep/er/nz/nzd/nb/nb2/pt/e)
 *  Q10-Q13: Career Anchor (categorical: tf/gm/au/se/en/sv)
 *  Q14-Q15: AI Exposure (scored 1-5)
 *  Q16-Q19: Adaptive Capacity (financial, transferability, network, AI usage)
 *  Q20:     Seniority (not scored)
 *  Q21:     Industry (not scored)
 *  Q22-Q23: Open text (not scored)
 */

function computeScores_(answers) {
  function val(idx) {
    if (!answers[idx]) return 0;
    var v = parseFloat(answers[idx].answer);
    return isNaN(v) ? 0 : v;
  }
  function raw(idx) {
    return answers[idx] ? answers[idx].answer : '';
  }

  // ── Adaptability (Q0-Q5) ──────────────────────────
  var concern1 = val(0), concern2 = val(1);
  var control1 = val(2), control2 = val(3);
  var curiosity = val(4), confidence = val(5);

  var concern_avg = (concern1 + concern2) / 2;
  var control_avg = (control1 + control2) / 2;
  var adaptability_total = concern1 + concern2 + control1 + control2 + curiosity + confidence;
  var adaptability_avg = Math.round((adaptability_total / 6) * 10) / 10;

  var adaptability_scores = {
    concern: Math.round(concern_avg * 10) / 10,
    control: Math.round(control_avg * 10) / 10,
    curiosity: curiosity,
    confidence: confidence
  };

  // ── Transition Phase (Q6-Q9) ──────────────────────
  var phase_counts = { pt: 0, endings: 0, neutral_zone: 0, new_beginnings: 0 };
  for (var i = 6; i <= 9; i++) {
    var v = raw(i);
    if (v === 'pt') phase_counts.pt++;
    else if (v === 'e' || v === 'er' || v === 'ep') phase_counts.endings++;
    else if (v === 'nz' || v === 'nzd') phase_counts.neutral_zone++;
    else if (v === 'nb' || v === 'nb2') phase_counts.new_beginnings++;
  }
  var transition_phase = 'neutral_zone';
  var max_phase = 0;
  for (var p in phase_counts) {
    if (phase_counts[p] > max_phase) {
      max_phase = phase_counts[p];
      transition_phase = p;
    }
  }

  var PHASE_LABELS = {
    pt: 'Pre-Transition',
    endings: 'Endings',
    neutral_zone: 'Neutral Zone',
    new_beginnings: 'New Beginnings'
  };

  // ── Career Anchor (Q10-Q13) ───────────────────────
  var ANCHOR_MAP = { tf: 'technical', gm: 'management', au: 'autonomy', se: 'security', en: 'entrepreneurial', sv: 'service' };
  var anchor_counts = {};
  for (var i = 10; i <= 13; i++) {
    var v = raw(i);
    var anchor = ANCHOR_MAP[v];
    if (anchor) {
      anchor_counts[anchor] = (anchor_counts[anchor] || 0) + 1;
    }
  }
  var sorted_anchors = Object.keys(anchor_counts).sort(function(a, b) { return anchor_counts[b] - anchor_counts[a]; });
  var anchor_primary = sorted_anchors[0] || 'autonomy';
  var anchor_secondary = sorted_anchors[1] || null;

  // ── AI Exposure (Q14-Q15) ─────────────────────────
  var exposure1 = val(14), exposure2 = val(15);
  var exposure_total = exposure1 + exposure2;
  var exposure_avg = Math.round((exposure_total / 2) * 10) / 10;

  // ── Adaptive Capacity (Q16-Q19) ───────────────────
  var financial = val(16), transferability = val(17), network = val(18), ai_usage = val(19);
  var capacity_total = financial + transferability + network + ai_usage;
  var capacity_avg = Math.round((capacity_total / 4) * 10) / 10;

  // ── Readiness Index ───────────────────────────────
  var readiness_index = adaptability_total + exposure_total + capacity_total;
  var readiness_max = 60;
  var readiness_level;
  if (readiness_index >= 48) readiness_level = 'high';
  else if (readiness_index >= 32) readiness_level = 'moderate';
  else if (readiness_index >= 18) readiness_level = 'low';
  else readiness_level = 'very_low';

  // ── Archetype ─────────────────────────────────────
  var high_adapt = adaptability_avg >= 3.5;
  var mod_adapt = adaptability_avg >= 2.5 && adaptability_avg < 3.5;
  var low_adapt = adaptability_avg < 2.5;

  var high_cap = capacity_avg >= 3.5;
  var mod_cap = capacity_avg >= 2.5 && capacity_avg < 3.5;
  var low_cap = capacity_avg < 2.5;

  var high_exp = exposure_avg >= 3.5;
  var mod_exp = exposure_avg >= 2.5 && exposure_avg < 3.5;
  var low_exp = exposure_avg < 2.5;

  var archetype, mastermind_fit;
  if (high_adapt && high_cap && high_exp) {
    archetype = 'architect'; mastermind_fit = 'excellent';
  } else if (high_adapt && (mod_cap || low_cap)) {
    archetype = 'strategist'; mastermind_fit = 'excellent';
  } else if (high_cap && (mod_adapt || low_adapt)) {
    archetype = 'builder'; mastermind_fit = 'excellent';
  } else if (high_adapt && (mod_cap || mod_exp)) {
    archetype = 'explorer'; mastermind_fit = 'ideal';
  } else if (mod_adapt && low_cap) {
    archetype = 'observer'; mastermind_fit = 'good';
  } else if (low_adapt && low_cap) {
    archetype = 'anchor'; mastermind_fit = 'conditional';
  } else {
    archetype = 'explorer'; mastermind_fit = 'good';
  }

  // ── Key Pattern ───────────────────────────────────
  var key_pattern;
  if (adaptability_avg > capacity_avg + 0.5) key_pattern = 'Adaptability > Capacity';
  else if (capacity_avg > adaptability_avg + 0.5) key_pattern = 'Capacity > Adaptability';
  else key_pattern = 'Balanced';

  // ── Flags ─────────────────────────────────────────
  var flags = [];
  if (raw(17) === '1') flags.push('pivot_blind_spot');
  if (network <= 2) flags.push('isolated');
  if (readiness_index < 18) flags.push('very_low_readiness');
  if (transition_phase === 'endings') flags.push('in_endings');

  // ── Profile fields ────────────────────────────────
  var seniority = raw(20);
  var industry = raw(21);
  var challenge = raw(22);
  var aspiration = raw(23);

  return {
    adaptability_total: adaptability_total,
    adaptability_avg: adaptability_avg,
    adaptability_scores: adaptability_scores,
    transition_phase: transition_phase,
    transition_label: PHASE_LABELS[transition_phase] || 'Neutral Zone',
    phase_counts: phase_counts,
    anchor_primary: anchor_primary,
    anchor_secondary: anchor_secondary,
    exposure_total: exposure_total,
    exposure_avg: exposure_avg,
    capacity_total: capacity_total,
    capacity_avg: capacity_avg,
    financial: financial,
    transferability: transferability,
    network: network,
    ai_usage: ai_usage,
    readiness_index: readiness_index,
    readiness_max: readiness_max,
    readiness_level: readiness_level,
    archetype: archetype,
    mastermind_fit: mastermind_fit,
    key_pattern: key_pattern,
    flags: flags,
    seniority: seniority,
    industry: industry,
    challenge: challenge,
    aspiration: aspiration
  };
}

// ═══════════════════════════════════════════════════════════
// ARCHETYPE & ANCHOR METADATA
// ═══════════════════════════════════════════════════════════

var ARCHETYPE_INFO = {
  architect: {
    name: 'The Architect',
    tagline: 'You see the blueprint. Now build it.',
    description: 'You score high across adaptability, capacity, and AI exposure. You\'re already leading the response. What you need isn\'t direction — it\'s a sounding board of equally sharp minds to stress-test your thinking.',
    insight: 'Your adaptability and capacity are both strong — that\'s rare. The risk isn\'t falling behind. It\'s building alone. The best architects have a crew.'
  },
  strategist: {
    name: 'The Strategist',
    tagline: 'You see it clearly. The gap is between knowing and doing.',
    description: 'Your adaptability is strong — you\'re psychologically ready for change. But your capacity or exposure hasn\'t caught up. You\'re thinking when you should be testing. This isn\'t a deficit — it\'s a pattern, and breaking it requires external pressure.',
    insight: 'Your adaptability is your asset. But high adaptability without matching action creates a knowing-doing gap. The Mastermind closes it.'
  },
  builder: {
    name: 'The Builder',
    tagline: 'You\'re moving fast. Make sure it\'s the right direction.',
    description: 'You have strong capacity — resources, network, transferable skills. But your psychological readiness may lag behind. You\'re solving the how before you\'ve answered the what and why.',
    insight: 'You\'re ahead of most people in practical resources. The question is whether you\'re building in the right direction. The right group gives you that correction fast.'
  },
  explorer: {
    name: 'The Explorer',
    tagline: 'You\'re open. You\'re ready. You need a bearing.',
    description: 'Your adaptability is your asset — you\'re psychologically ready. But you haven\'t locked in the practical steps. The right group gives you that frame.',
    insight: 'Your adaptability scores are your strongest dimension. You\'re open to change and confident you\'ll manage. What you need isn\'t courage — it\'s a map. The Mastermind gives you one.'
  },
  observer: {
    name: 'The Observer',
    tagline: 'You\'re watching from a distance. It\'s time to step in.',
    description: 'You see what\'s happening. You haven\'t fully engaged with it yet. The picture sharpens through engagement, not before it. The Observer\'s risk: waiting becomes the strategy.',
    insight: 'You understand more than you\'re acting on. That\'s not laziness — it\'s a pattern. The Observer needs a deadline and a group that won\'t let them postpone.'
  },
  anchor: {
    name: 'The Anchor',
    tagline: 'You\'re holding steady. The question is whether the ground beneath you is.',
    description: 'You\'re not where this conversation is happening yet. The gap between your engagement and the pace of change is worth examining — not with panic, but with honesty.',
    insight: 'Your scores suggest you haven\'t fully engaged with AI disruption yet. That\'s not a judgment — it\'s a starting point. This assessment is itself a step. The question is what you do next.'
  }
};

var ANCHOR_LABELS = {
  technical: 'Technical Mastery',
  management: 'Leadership & Management',
  autonomy: 'Autonomy / Independence',
  security: 'Security & Stability',
  entrepreneurial: 'Entrepreneurial Creativity',
  service: 'Service & Impact'
};

var ANCHOR_STRENGTHS = {
  technical: 'deep domain expertise that grounds the conversation',
  management: 'strategic thinking and a systems perspective',
  autonomy: 'independent thinking and willingness to challenge assumptions',
  security: 'pragmatism and grounded risk awareness',
  entrepreneurial: 'creative problem-solving and builder energy',
  service: 'purpose-driven clarity that elevates the group'
};

var ANCHOR_DESCRIPTIONS = {
  technical: 'Being the best at what you do is non-negotiable. AI is both threat (automating expertise) and opportunity (you can become the expert in how AI applies to your field).',
  management: 'You want to lead and influence outcomes. Your path through disruption runs through understanding how AI changes strategy, not just operations.',
  autonomy: 'Working on your own terms is non-negotiable. AI-era careers reward autonomous thinkers. The risk: autonomy without direction becomes drift.',
  security: 'You value stability. The question: how do you build security when old forms of it are dissolving?',
  entrepreneurial: 'You want to build things. AI isn\'t a threat — it\'s raw material. Your challenge is focus.',
  service: 'You\'re driven by impact. AI can amplify that or distract from it. Stay anchored in the impact you want to make.'
};

var PHASE_DESCRIPTIONS = {
  pt: 'You haven\'t yet felt the disruption directly — or you\'ve chosen not to engage with it. This is a window of opportunity, not safety. The earlier you start thinking about this, the more options you have.',
  endings: 'You\'re in the Endings phase — letting go of how things were. This is the hardest part. You know things are changing but the old identity, routines, and certainties still pull. Grief here is normal. Clarity comes next.',
  neutral_zone: 'You\'re in the Neutral Zone — between what was and what will be. This is disorienting but productive. The confusion isn\'t a problem — it\'s the process. The Mastermind accelerates this phase significantly.',
  new_beginnings: 'You\'re moving into New Beginnings — you can see the future and you\'re moving toward it. Energy is returning. The question now is execution: which of the many possibilities do you commit to?'
};

// ═══════════════════════════════════════════════════════════
// SHEETS: LEADS + ASSESSMENTS
// ═══════════════════════════════════════════════════════════

function saveToLeadsSheet_(data, answers) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var LEADS_HEADERS = [
    'Timestamp', 'Email', 'LinkedIn', 'Phone', 'Contact Preference',
    'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10',
    'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17', 'Q18',
    'Q19', 'Q20', 'Q21 (Seniority)', 'Q22 (Industry)', 'Q23 (Challenge)', 'Q24 (Aspiration)'
  ];

  var ws = ss.getSheetByName(SHEET_LEADS);
  if (!ws) {
    ws = ss.insertSheet(SHEET_LEADS);
    ws.getRange(1, 1, 1, LEADS_HEADERS.length).setValues([LEADS_HEADERS]);
    ws.getRange(1, 1, 1, LEADS_HEADERS.length).setFontWeight('bold');
  }

  var row = [
    data.timestamp || new Date().toISOString(),
    data.email || '', data.linkedin || '', data.phone || '', data.contact || ''
  ];
  for (var i = 0; i < 24; i++) {
    row.push(answers[i] ? answers[i].answer : '');
  }
  ws.appendRow(row);
}

function saveToAssessmentsSheet_(data, scores) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var HEADERS = [
    'Timestamp', 'Source', 'Email', 'LinkedIn', 'Phone', 'Contact Preference',
    'Archetype', 'Mastermind Fit', 'Readiness Index',
    'Adaptability Avg', 'Exposure Avg', 'Capacity Avg',
    'Concern', 'Control', 'Curiosity', 'Confidence',
    'Transition Phase',
    'Anchor Primary', 'Anchor Secondary',
    'Network', 'Transferability',
    'Seniority', 'Industry',
    'Challenge', 'Aspiration'
  ];

  var ws = ss.getSheetByName(SHEET_ASSESSMENTS);
  if (!ws) {
    ws = ss.insertSheet(SHEET_ASSESSMENTS);
    ws.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    ws.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }

  var row = [
    new Date().toISOString(),
    'website',
    data.email || '',
    data.linkedin || '',
    data.phone || '',
    data.contact || '',
    scores.archetype,
    scores.mastermind_fit,
    scores.readiness_index,
    scores.adaptability_avg,
    scores.exposure_avg,
    scores.capacity_avg,
    scores.adaptability_scores.concern,
    scores.adaptability_scores.control,
    scores.adaptability_scores.curiosity,
    scores.adaptability_scores.confidence,
    scores.transition_label,
    ANCHOR_LABELS[scores.anchor_primary] || scores.anchor_primary,
    scores.anchor_secondary ? (ANCHOR_LABELS[scores.anchor_secondary] || scores.anchor_secondary) : '',
    scores.network,
    scores.transferability,
    scores.seniority,
    scores.industry,
    scores.challenge,
    scores.aspiration
  ];

  ws.appendRow(row);

  // Color row by mastermind fit
  var rowNum = ws.getLastRow();
  var fit = scores.mastermind_fit;
  var colors = {
    excellent: '#D9F0D9',
    ideal: '#D9F0D9',
    good: '#FFF8D9',
    conditional: '#FFE6CC'
  };
  if (colors[fit]) {
    ws.getRange(rowNum, 1, 1, HEADERS.length).setBackground(colors[fit]);
  }
}

// ═══════════════════════════════════════════════════════════
// PDF REPORT GENERATION (Google Doc → PDF)
// ═══════════════════════════════════════════════════════════

function generateReportPdf_(payload) {
  var s = payload.scores;
  var arch = ARCHETYPE_INFO[s.archetype] || ARCHETYPE_INFO['explorer'];
  var anchorLabel = ANCHOR_LABELS[s.anchor_primary] || s.anchor_primary;
  var anchorSecLabel = s.anchor_secondary ? (ANCHOR_LABELS[s.anchor_secondary] || s.anchor_secondary) : '';
  var anchorDesc = ANCHOR_DESCRIPTIONS[s.anchor_primary] || ANCHOR_DESCRIPTIONS['autonomy'];
  var anchorStrength = ANCHOR_STRENGTHS[s.anchor_primary] || 'a unique perspective';
  var phaseDesc = PHASE_DESCRIPTIONS[s.transition_phase] || PHASE_DESCRIPTIONS['neutral_zone'];
  var dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'MMMM yyyy');

  // ── Readiness text ──
  var readinessText;
  if (s.readiness_level === 'high' || s.readiness_level === 'moderate') {
    readinessText = 'You have the adaptability and resources to act decisively — the gap is execution.';
  } else {
    readinessText = 'There is meaningful room to grow in how you engage with AI disruption.';
  }

  // ── Adaptability-Capacity gap ──
  var gapText;
  if (s.adaptability_avg > s.capacity_avg + 0.5) {
    gapText = 'Your psychological readiness outpaces your practical capacity. You\'re mentally ready for change but haven\'t built all the infrastructure to execute on it. The Mastermind helps close this gap through structured accountability.';
  } else if (s.capacity_avg > s.adaptability_avg + 0.5) {
    gapText = 'You have strong practical resources but your psychological readiness hasn\'t caught up. You have the tools — you need the mindset shift. The right peer group creates that shift faster than solo reflection.';
  } else {
    gapText = 'Your adaptability and capacity are well-matched — a strong foundation. The question is depth: are you going deep enough in the right areas? Balanced profiles benefit most from diverse perspectives.';
  }

  // ── Strength/growth edge ──
  var adpScores = s.adaptability_scores;
  var adpSorted = Object.keys(adpScores).sort(function(a, b) { return adpScores[b] - adpScores[a]; });
  var labels = { concern: 'Concern', control: 'Control', curiosity: 'Curiosity', confidence: 'Confidence' };
  var strongest = labels[adpSorted[0]];
  var weakest = labels[adpSorted[adpSorted.length - 1]];

  // ── Build HTML ──
  var html = '<!DOCTYPE html><html><head><style>';
  html += 'body { font-family: Helvetica, Arial, sans-serif; color: #2A2A2A; margin: 0; padding: 0; font-size: 10pt; line-height: 1.6; }';
  html += '.page { page-break-after: always; padding: 60px; min-height: 900px; position: relative; }';
  html += '.page:last-child { page-break-after: auto; }';
  html += 'h1 { font-size: 28pt; font-weight: 900; color: #000; margin: 0; }';
  html += 'h2 { font-size: 22pt; font-weight: 800; color: #000; margin: 0 0 8px 0; }';
  html += 'h3 { font-size: 14pt; font-weight: 700; color: #000; margin: 0 0 6px 0; }';
  html += '.gold { color: #A98849; }';
  html += '.gray { color: #777; }';
  html += '.light { color: #AAA; }';
  html += '.label { font-size: 8pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #A98849; }';
  html += '.gold-line { border-top: 2px solid #A98849; width: 55px; margin: 4px 0 24px 0; }';
  html += '.gold-box { background: #A98849; color: #fff; padding: 22px; border-radius: 8px; margin: 20px 0; }';
  html += '.gold-box h3, .gold-box p { color: #fff; }';
  html += '.dark-box { background: #8A6D38; color: #fff; padding: 14px 18px; border-radius: 5px; display: inline-block; margin: 4px; }';
  html += '.bar-container { margin: 8px 0; }';
  html += '.bar-label { font-size: 8pt; font-weight: 700; text-transform: uppercase; color: #2A2A2A; margin-bottom: 3px; }';
  html += '.bar-track { background: #E0E0E0; height: 8px; border-radius: 4px; position: relative; }';
  html += '.bar-fill { background: #A98849; height: 8px; border-radius: 4px; min-width: 8px; }';
  html += '.bar-score { font-size: 9pt; font-weight: 700; color: #2A2A2A; float: right; margin-top: -22px; }';
  html += '.score-big { font-size: 44pt; font-weight: 900; color: #000; }';
  html += '.score-max { font-size: 16pt; color: #AAA; }';
  html += '.header { border-bottom: 0.5px solid #E0E0E0; padding-bottom: 4px; margin-bottom: 16px; font-size: 7.5pt; color: #AAA; }';
  html += '.header .brand { color: #A98849; float: left; }';
  html += '.header .title { float: right; }';
  html += '.header::after { content: ""; display: table; clear: both; }';
  html += '.footer { position: absolute; bottom: 30px; left: 60px; right: 60px; border-top: 0.3px solid #E0E0E0; padding-top: 6px; font-size: 7pt; color: #AAA; }';
  html += '.footer .left { float: left; } .footer .center { text-align: center; } .footer .right { float: right; }';
  html += '.indicator-row { margin: 8px 0; } .indicator-label { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; color: #777; display: inline-block; width: 130px; } .indicator-value { font-size: 13pt; font-weight: 700; color: #000; }';
  html += '.indicator-sub { font-size: 7pt; color: #AAA; margin-left: 130px; margin-top: -4px; }';
  html += '.action-num { font-size: 28pt; font-weight: 700; color: #A98849; display: inline-block; width: 40px; vertical-align: top; }';
  html += '.action-body { display: inline-block; width: calc(100% - 50px); vertical-align: top; }';
  html += '.action-title { font-size: 13pt; font-weight: 700; color: #000; margin-bottom: 4px; }';
  html += 'table.metrics { width: 100%; border-collapse: collapse; } table.metrics td { padding: 8px 0; }';
  html += '</style></head><body>';

  // ── PAGE 1: COVER ──
  html += '<div class="page" style="text-align:center; padding-top: 200px;">';
  html += '<p class="gold" style="font-size:14pt; font-weight:700; letter-spacing:0.15em;">HIGHGATE SOCIETY</p>';
  html += '<div style="border-top:1px solid #A98849; width:60px; margin:40px auto;"></div>';
  html += '<h1>AI Readiness Report</h1>';
  html += '<p class="gold" style="font-size:14pt; margin-top:16px;">Prepared for ' + (payload.email || 'Participant') + '</p>';
  html += '<p class="gray" style="font-size:10pt;">' + dateStr + '</p>';
  html += '<div style="position:absolute; bottom:70px; left:60px; right:60px; text-align:center;">';
  html += '<p class="light" style="font-size:7.5pt;">Based on the Career Adapt-Abilities Scale (Savickas, 2012), Bridges Transition Model (1991),<br>and Schein Career Anchors Framework (2023)</p>';
  html += '<div style="border-top:0.3px solid #E0E0E0; margin:8px 0;"></div>';
  html += '<p class="light" style="font-size:7pt;">CONFIDENTIAL — Prepared exclusively for the named recipient</p>';
  html += '</div></div>';

  // ── PAGE 2: ARCHETYPE ──
  html += '<div class="page">';
  html += makeHeader_();
  html += '<p class="label">YOUR PROFILE</p><div class="gold-line"></div>';
  html += '<h1 style="font-size:34pt;">' + arch.name + '</h1>';
  html += '<p class="gray" style="font-style:italic; font-size:11.5pt; margin: 8px 0 24px 0;">' + arch.tagline + '</p>';
  html += '<div class="gold-box"><p style="font-size:10.5pt; line-height:1.7;">' + arch.description + '</p></div>';
  html += '<p class="label" style="margin-top:28px;">KEY INDICATORS</p><div class="gold-line"></div>';
  html += '<div class="indicator-row"><span class="indicator-label">Readiness Index</span><span class="indicator-value">' + s.readiness_index + ' / ' + s.readiness_max + '</span></div>';
  html += '<div class="indicator-sub">Composite Score</div>';
  html += '<div class="indicator-row"><span class="indicator-label">Career Anchor</span><span class="indicator-value">' + anchorLabel + '</span></div>';
  html += '<div class="indicator-sub">Schein Framework</div>';
  html += '<div class="indicator-row"><span class="indicator-label">Transition Phase</span><span class="indicator-value">' + s.transition_label + '</span></div>';
  html += '<div class="indicator-sub">Bridges Model</div>';
  html += '<div class="indicator-row"><span class="indicator-label">Key Pattern</span><span class="indicator-value">' + s.key_pattern + '</span></div>';
  html += '<div class="indicator-sub">Profile Signature</div>';
  html += '<div class="gold-box" style="margin-top:24px;">';
  html += '<p style="font-size:9pt; font-weight:700; margin-bottom:8px;">WHAT YOUR READINESS INDEX MEANS</p>';
  html += '<p style="font-size:9.5pt; line-height:1.6;">A score of <b>' + s.readiness_index + '/' + s.readiness_max + '</b> — ' + readinessText + ' This report shows you exactly where the gaps are — and what to do about them.</p>';
  html += '</div>';
  html += makeFooter_(2);
  html += '</div>';

  // ── PAGE 3: ADAPTABILITY ──
  html += '<div class="page">';
  html += makeHeader_();
  html += '<p class="label">DIMENSION 1</p><div class="gold-line"></div>';
  html += '<h2>Adaptability</h2>';
  html += '<p class="gray" style="font-size:9pt;">Career Adapt-Abilities Scale (Savickas & Porfeli, 2012)</p>';
  html += '<p style="margin:20px 0;"><span class="score-big">' + s.adaptability_avg.toFixed(1) + '</span> <span class="score-max">/ 5.0</span></p>';
  html += makeBar_('Concern', adpScores.concern, 5);
  html += makeBar_('Control', adpScores.control, 5);
  html += makeBar_('Curiosity', adpScores.curiosity, 5);
  html += makeBar_('Confidence', adpScores.confidence, 5);
  html += '<div style="margin-top:24px;">';
  html += '<h3>Your Strength: ' + strongest + '</h3>';
  html += '<p>You scored highest here. This is the foundation — and most professionals don\'t have it.</p>';
  html += '</div>';
  html += '<div style="margin-top:16px;">';
  html += '<h3>Your Growth Edge: ' + weakest + '</h3>';
  html += '<p>This area has the most room for improvement. Sharpening it will have the biggest impact on your readiness.</p>';
  html += '</div>';
  html += makeFooter_(3);
  html += '</div>';

  // ── PAGE 4: TRANSITION PHASE + AI EXPOSURE ──
  html += '<div class="page">';
  html += makeHeader_();
  html += '<p class="label">DIMENSION 2</p><div class="gold-line"></div>';
  html += '<h2>Transition Phase</h2>';
  html += '<p class="gray" style="font-size:9pt;">Bridges Transition Model (Bridges & Bridges, 2017)</p>';
  html += '<p style="margin:16px 0;"><span class="indicator-value" style="font-size:22pt;">' + s.transition_label + '</span></p>';
  html += '<p style="margin-bottom:24px;">' + phaseDesc + '</p>';

  html += '<p class="label" style="margin-top:32px;">DIMENSION 3</p><div class="gold-line"></div>';
  html += '<h2>AI Exposure</h2>';
  html += '<p class="gray" style="font-size:9pt;">How much is AI already affecting your work?</p>';
  html += '<p style="margin:20px 0;"><span class="score-big">' + s.exposure_avg.toFixed(1) + '</span> <span class="score-max">/ 5.0</span></p>';

  html += '<p class="label" style="margin-top:32px;">DIMENSION 4</p><div class="gold-line"></div>';
  html += '<h2>Adaptive Capacity</h2>';
  html += '<p class="gray" style="font-size:9pt;">Financial runway, transferable skills, network, AI fluency</p>';
  html += '<p style="margin:20px 0;"><span class="score-big">' + s.capacity_avg.toFixed(1) + '</span> <span class="score-max">/ 5.0</span></p>';
  html += makeBar_('Financial Runway', s.financial, 5);
  html += makeBar_('Transferable Skills', s.transferability, 5);
  html += makeBar_('Professional Network', s.network, 5);
  html += makeBar_('AI Fluency', s.ai_usage, 5);
  html += makeFooter_(4);
  html += '</div>';

  // ── PAGE 5: CAREER ANCHOR + GAP ──
  html += '<div class="page">';
  html += makeHeader_();
  html += '<p class="label">DIMENSION 5</p><div class="gold-line"></div>';
  html += '<h2>Your Career Anchor</h2>';
  html += '<p class="gray" style="font-size:9pt;">Schein Career Anchors (Schein, Van Maanen & Schein, 2023)</p>';
  html += '<p style="margin:16px 0;"><span class="gray" style="font-size:12pt;">Primary: </span><span style="font-size:14pt; font-weight:700; color:#8A6D38;">' + anchorLabel + '</span></p>';
  if (anchorSecLabel) {
    html += '<p><span class="gray" style="font-size:10pt;">Secondary: </span><span style="color:#444;">' + anchorSecLabel + '</span></p>';
  }
  html += '<p style="margin:16px 0;">' + anchorDesc + '</p>';
  if (anchorSecLabel) {
    html += '<p class="gray" style="font-size:9pt;">Secondary: <b>' + anchorSecLabel + '</b> — this adds nuance to how you navigate decisions.</p>';
  }

  html += '<div class="gold-box" style="margin-top:32px;">';
  html += '<h3 style="font-size:16pt; margin-bottom:16px;">' + (s.key_pattern === 'Balanced' ? 'Balanced Profile' : 'The Adaptability – Capacity Gap') + '</h3>';
  html += '<div style="display:flex; gap:16px; margin-bottom:16px;">';
  html += '<div class="dark-box" style="flex:1; text-align:center;"><p style="font-size:7.5pt; font-weight:700; margin-bottom:4px;">ADAPTABILITY</p><p style="font-size:18pt; font-weight:700;">' + s.adaptability_avg.toFixed(1) + ' / 5.0</p></div>';
  html += '<div class="dark-box" style="flex:1; text-align:center;"><p style="font-size:7.5pt; font-weight:700; margin-bottom:4px;">ADAPTIVE CAPACITY</p><p style="font-size:18pt; font-weight:700;">' + s.capacity_avg.toFixed(1) + ' / 5.0</p></div>';
  html += '</div>';
  html += '<p style="font-size:9.5pt; line-height:1.5;">' + gapText + '</p>';
  html += '</div>';
  html += makeFooter_(5);
  html += '</div>';

  // ── PAGE 6: ACTIONS ──
  html += '<div class="page">';
  html += makeHeader_();
  html += '<p class="label">YOUR NEXT MOVES</p><div class="gold-line"></div>';
  html += '<h2>Three Things You Can Do This Week</h2>';
  html += '<div style="margin-top:28px;">';

  var actions = [
    ['01', 'Map the Fork', 'Take one core process and split it: what can AI do now? What can\'t it? What could it but shouldn\'t? Write it down. Once you see it for one process, you\'ll see it everywhere.'],
    ['02', 'Run One Real Experiment', 'Pick the lowest-stakes part and hand it to AI this week. Actually do it. Compare the output. One real test beats six months of reading.'],
    ['03', 'Have the Conversation You\'re Avoiding', 'There\'s a decision you\'ve been postponing. Find one person you trust and say it out loud. The decision gets clearer when it leaves your head. If you don\'t have that person — that\'s what the Mastermind is for.']
  ];
  for (var i = 0; i < actions.length; i++) {
    html += '<div style="margin-bottom:24px;"><span class="action-num">' + actions[i][0] + '</span>';
    html += '<div class="action-body"><div class="action-title">' + actions[i][1] + '</div>';
    html += '<p>' + actions[i][2] + '</p></div></div>';
  }

  html += '<div class="gold-box" style="margin-top:20px;">';
  html += '<h3>The Highgate Society Mastermind</h3>';
  html += '<p style="font-size:9.5pt; line-height:1.6; margin:12px 0;">5–7 professionals from different industries navigating the same reality. Six weeks of structured, facilitated sessions. Not a course. Not networking. The sharpest conversation you\'ll have about AI and your work this year.</p>';
  html += '<p style="font-size:9.5pt; line-height:1.6;">Based on your profile, you\'d bring ' + anchorStrength + ' — and the group would close the gap you can\'t close alone.</p>';
  html += '<p style="font-size:10pt; font-weight:700; margin-top:16px;">Apply → highgatesociety.com</p>';
  html += '</div>';
  html += makeFooter_(6);
  html += '</div>';

  // ── PAGE 7: REFERENCES ──
  html += '<div class="page">';
  html += makeHeader_();
  html += '<p class="label">METHODOLOGY</p><div class="gold-line"></div>';
  html += '<h2 style="font-size:18pt;">About This Assessment</h2>';
  html += '<p style="margin:12px 0;">This report was generated from the Highgate Society AI Readiness Assessment — a 24-question diagnostic integrating three peer-reviewed frameworks from career psychology and change management. Designed to illuminate, not diagnose.</p>';
  html += '<h3 style="font-size:11pt; margin-top:24px;">Frameworks & References</h3>';
  var refs = [
    '<b>Career Adapt-Abilities Scale</b> — Savickas & Porfeli (2012). J. of Vocational Behavior, 80(3).',
    '<b>Career Construction Theory</b> — Savickas (2005). In Brown & Lent, Career development and counseling.',
    '<b>Bridges Transition Model</b> — Bridges & Bridges (2017). Managing Transitions, 4th ed.',
    '<b>Career Anchors</b> — Schein, Van Maanen & Schein (2023). Career Anchors Reimagined, 5th ed.',
    '<b>AI & Adaptive Capacity</b> — Muro et al. (2026). Brookings Institution.',
    '<b>AI Labour Market Impacts</b> — Anthropic Economic Index (Handa et al., 2025).'
  ];
  html += '<div style="margin-top:12px; font-size:8pt; color:#777; line-height:1.8;">';
  for (var i = 0; i < refs.length; i++) {
    html += '<p>' + refs[i] + '</p>';
  }
  html += '</div>';
  html += '<div style="text-align:center; margin-top:40px;">';
  html += '<p class="light" style="font-size:8pt;">highgatesociety.com | hello@highgatesociety.com</p>';
  html += '<p class="gold" style="font-size:12pt; font-weight:700; letter-spacing:0.15em; margin-top:20px;">HIGHGATE SOCIETY</p>';
  html += '</div>';
  html += '</div>';

  html += '</body></html>';

  // Convert HTML to PDF via temp Google Doc
  var blob = HtmlService.createHtmlOutput(html).getBlob().setName('AI_Readiness_Report.html');
  var tempDoc = Drive.Files.insert(
    { title: 'Temp_Report_' + new Date().getTime(), mimeType: 'application/vnd.google-apps.document' },
    blob,
    { convert: true }
  );

  var pdfBlob = DriveApp.getFileById(tempDoc.id).getAs('application/pdf');
  pdfBlob.setName('Highgate_Society_AI_Readiness_Report.pdf');

  // Delete temp doc
  DriveApp.getFileById(tempDoc.id).setTrashed(true);

  return pdfBlob;
}

function makeHeader_() {
  return '<div class="header"><span class="brand">HIGHGATE SOCIETY</span><span class="title">AI Readiness Report</span></div>';
}

function makeFooter_(pageNum) {
  return '<div class="footer"><span class="left">highgatesociety.com</span><span class="center">Professional Coaching for the Age of AI</span><span class="right">' + pageNum + '</span></div>';
}

function makeBar_(label, score, max) {
  var pct = max > 0 ? Math.max((score / max) * 100, 3) : 3;
  return '<div class="bar-container">' +
    '<div class="bar-label">' + label.toUpperCase() + '</div>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;"></div></div>' +
    '<div class="bar-score">' + score + ' / ' + max + '</div>' +
    '</div>';
}

// ═══════════════════════════════════════════════════════════
// EMAIL TEMPLATE
// ═══════════════════════════════════════════════════════════

function buildEmailHtml_(payload) {
  var arch = ARCHETYPE_INFO[payload.scores.archetype] || ARCHETYPE_INFO['explorer'];
  return '<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2A2A2A;max-width:600px;margin:0 auto;padding:40px 20px;">' +
    '<p style="color:#A98849;font-size:12px;font-weight:700;letter-spacing:0.15em;">HIGHGATE SOCIETY</p>' +
    '<h1 style="font-size:24px;font-weight:800;margin:20px 0 8px;">Your AI Readiness Report is ready.</h1>' +
    '<p style="font-size:16px;color:#777;margin-bottom:24px;">Your profile: <strong style="color:#000;">' + arch.name + '</strong></p>' +
    '<p style="font-size:14px;line-height:1.7;">' + arch.tagline + '</p>' +
    '<p style="font-size:14px;line-height:1.7;margin-top:16px;">Your full report is attached as a PDF — it includes your scores across all five dimensions, your career anchor analysis, your transition phase, and three concrete actions for this week.</p>' +
    '<p style="font-size:14px;line-height:1.7;margin-top:16px;">If what you read resonates, the next step is a 15-minute conversation to see if the Mastermind is the right fit.</p>' +
    '<div style="margin:32px 0;"><a href="https://highgatesociety.com" style="background:#1A1A1A;color:#fff;padding:14px 32px;text-decoration:none;font-size:14px;font-weight:700;border-radius:4px;">Learn More →</a></div>' +
    '<p style="font-size:12px;color:#AAA;margin-top:40px;border-top:1px solid #E0E0E0;padding-top:16px;">Highgate Society — Professional Coaching for the Age of AI<br>hello@highgatesociety.com</p>' +
    '</body></html>';
}
