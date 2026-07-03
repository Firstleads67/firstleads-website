const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

async function sendEmail(env, to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Marvin Oosterhof <marvin@firstleads.nl>',
      to: [to],
      subject,
      text,
    }),
  });
  return res.ok;
}

async function sendWhatsApp(env, message) {
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=31640997278&text=${encodeURIComponent(message)}&apikey=${env.CALLMEBOT_API_KEY}`;
    await fetch(url);
  } catch (_) {}
}

function replacePlaceholders(text, prospect) {
  const voornaam = (prospect.contact_name || '').split(' ')[0] || 'daar';
  return text
    .replace(/{{voornaam}}/g, voornaam)
    .replace(/{{bedrijf}}/g, prospect.company_name || '')
    .replace(/{{industrie}}/g, prospect.industry || 'jullie sector');
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ── POST /api/submit ──────────────────────────────────────────────
  if (path === '/api/submit' && method === 'POST') {
    const body = await request.json();
    const { naam, bedrijf, email, telefoon, probleem, pakket_interesse } = body;
    await env.DB.prepare(
      `INSERT INTO leads (naam, bedrijf, email, telefoon, probleem, pakket_interesse) VALUES (?,?,?,?,?,?)`
    ).bind(naam, bedrijf, email, telefoon, probleem, pakket_interesse).run();

    const msg = `🚀 Nieuwe lead FirstLeads!\n${naam} — ${bedrijf}\n${email} | ${telefoon}\nPakket: ${pakket_interesse}\nProbleem: ${probleem}`;
    await sendWhatsApp(env, msg);
    await sendEmail(env, 'marvin@firstleads.nl', `Nieuwe lead: ${naam} — ${bedrijf}`, msg);
    return json({ ok: true });
  }

  // ── LEADS ────────────────────────────────────────────────────────
  if (path === '/api/leads' && method === 'GET') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const { results } = await env.DB.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
    return json(results);
  }
  if (path.startsWith('/api/leads/') && method === 'PATCH') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const id = path.split('/').pop();
    const body = await request.json();
    const fields = Object.keys(body).map(k => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE leads SET ${fields} WHERE id=?`).bind(...Object.values(body), id).run();
    return json({ ok: true });
  }
  if (path.startsWith('/api/leads/') && method === 'DELETE') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const id = path.split('/').pop();
    await env.DB.prepare('DELETE FROM leads WHERE id=?').bind(id).run();
    return json({ ok: true });
  }

  // ── PROSPECTS ─────────────────────────────────────────────────────
  if (path === '/api/prospects' && method === 'GET') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const status = url.searchParams.get('status');
    const industry = url.searchParams.get('industry');
    let q = 'SELECT * FROM prospects WHERE 1=1';
    const binds = [];
    if (status) { q += ' AND status=?'; binds.push(status); }
    if (industry) { q += ' AND industry=?'; binds.push(industry); }
    q += ' ORDER BY created_at DESC';
    const { results } = await env.DB.prepare(q).bind(...binds).all();
    return json(results);
  }
  if (path === '/api/prospects' && method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const b = await request.json();
    const { lastRowId } = await env.DB.prepare(
      `INSERT INTO prospects (company_name, website, linkedin_company_url, industry, size, contact_name, contact_title, contact_linkedin, contact_email, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(b.company_name, b.website, b.linkedin_company_url, b.industry, b.size, b.contact_name, b.contact_title, b.contact_linkedin, b.contact_email, b.notes).run();
    return json({ ok: true, id: lastRowId });
  }
  if (path.match(/^\/api\/prospects\/\d+$/) && method === 'GET') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const id = path.split('/').pop();
    const row = await env.DB.prepare('SELECT * FROM prospects WHERE id=?').bind(id).first();
    return json(row);
  }
  if (path.match(/^\/api\/prospects\/\d+$/) && method === 'PATCH') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const id = path.split('/').pop();
    const b = await request.json();
    const fields = Object.keys(b).map(k => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE prospects SET ${fields}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(b), id).run();
    return json({ ok: true });
  }
  if (path.match(/^\/api\/prospects\/\d+$/) && method === 'DELETE') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const id = path.split('/').pop();
    await env.DB.prepare('DELETE FROM prospects WHERE id=?').bind(id).run();
    return json({ ok: true });
  }

  // ── OUTREACH SEQUENCES ────────────────────────────────────────────
  if (path === '/api/outreach-sequences' && method === 'GET') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const { results } = await env.DB.prepare('SELECT * FROM outreach_sequences ORDER BY channel, delay_days').all();
    return json(results);
  }
  if (path.match(/^\/api\/outreach-sequences\/\d+$/) && method === 'PUT') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const id = path.split('/').pop();
    const { label, subject, body: emailBody, delay_days } = await request.json();
    await env.DB.prepare('UPDATE outreach_sequences SET label=?, subject=?, body=?, delay_days=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(label, subject, emailBody, delay_days, id).run();
    return json({ ok: true });
  }

  // ── SEND EMAIL VIA SEQUENCE ───────────────────────────────────────
  if (path.match(/^\/api\/outreach-sequences\/send\/\d+$/) && method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const seqId = path.split('/').pop();
    const { prospect_id } = await request.json();
    const seq = await env.DB.prepare('SELECT * FROM outreach_sequences WHERE id=?').bind(seqId).first();
    const prospect = await env.DB.prepare('SELECT * FROM prospects WHERE id=?').bind(prospect_id).first();
    if (!seq || !prospect) return json({ error: 'Not found' }, 404);
    const subject = replacePlaceholders(seq.subject, prospect);
    const body = replacePlaceholders(seq.body, prospect);
    await sendEmail(env, prospect.contact_email, subject, body);
    await env.DB.prepare('UPDATE prospects SET email_sent_at=CURRENT_TIMESTAMP, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind('email_sent', prospect_id).run();
    return json({ ok: true });
  }

  // ── LINKEDIN ──────────────────────────────────────────────────────
  if (path.match(/^\/api\/linkedin\/send\/\d+$/) && method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const seqId = path.split('/').pop();
    const { prospect_id } = await request.json();
    const seq = await env.DB.prepare('SELECT * FROM outreach_sequences WHERE id=?').bind(seqId).first();
    const prospect = await env.DB.prepare('SELECT * FROM prospects WHERE id=?').bind(prospect_id).first();
    if (!seq || !prospect) return json({ error: 'Not found' }, 404);
    const bericht = replacePlaceholders(seq.body, prospect);
    await env.DB.prepare('INSERT INTO linkedin_messages (prospect_id, stap, bericht, sent_at) VALUES (?,?,?,CURRENT_TIMESTAMP)')
      .bind(prospect_id, seq.delay_days, bericht).run();
    await env.DB.prepare('UPDATE prospects SET linkedin_sent_at=CURRENT_TIMESTAMP, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind('linkedin_sent', prospect_id).run();
    return json({ ok: true });
  }

  // ── INBOUND REPLY ─────────────────────────────────────────────────
  if (path === '/api/inbound-reply' && method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const { prospect_id, notes } = await request.json();
    await env.DB.prepare('UPDATE prospects SET status=?, replied_at=CURRENT_TIMESTAMP, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind('replied', notes, prospect_id).run();
    const prospect = await env.DB.prepare('SELECT * FROM prospects WHERE id=?').bind(prospect_id).first();
    await sendWhatsApp(env, `💬 Reply ontvangen! ${prospect?.company_name} — ${prospect?.contact_name}\n${notes}`);
    return json({ ok: true });
  }

  // ── STATS ─────────────────────────────────────────────────────────
  if (path === '/api/stats' && method === 'GET') {
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
    const [total, replied, meetings, klanten, leads] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as n FROM prospects').first(),
      env.DB.prepare("SELECT COUNT(*) as n FROM prospects WHERE status='replied'").first(),
      env.DB.prepare("SELECT COUNT(*) as n FROM prospects WHERE status='meeting'").first(),
      env.DB.prepare("SELECT COUNT(*) as n FROM prospects WHERE status='klant'").first(),
      env.DB.prepare("SELECT COUNT(*) as n FROM leads WHERE created_at >= datetime('now','-7 days')").first(),
    ]);
    return json({
      total_prospects: total?.n || 0,
      replied: replied?.n || 0,
      meetings: meetings?.n || 0,
      klanten: klanten?.n || 0,
      leads_this_week: leads?.n || 0,
    });
  }

  // ── MIGRATE ───────────────────────────────────────────────────────
  if (path === '/api/migrate' && method === 'POST') {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT, bedrijf TEXT, email TEXT, telefoon TEXT, probleem TEXT, pakket_interesse TEXT, status TEXT DEFAULT 'nieuw', notities TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS prospects (id INTEGER PRIMARY KEY AUTOINCREMENT, company_name TEXT, website TEXT, linkedin_company_url TEXT, industry TEXT, size TEXT, contact_name TEXT, contact_title TEXT, contact_linkedin TEXT, contact_email TEXT, status TEXT DEFAULT 'pending', linkedin_sent_at DATETIME, email_sent_at DATETIME, replied_at DATETIME, meeting_at DATETIME, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS outreach_sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, label TEXT, delay_days INTEGER, subject TEXT, body TEXT, channel TEXT DEFAULT 'email', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS linkedin_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER, stap INTEGER, bericht TEXT, sent_at DATETIME, replied_at DATETIME)`,
      `CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER, lead_id INTEGER, datum DATETIME, type TEXT, status TEXT DEFAULT 'gepland', notities TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('email_1','Email 1 - Eerste contact',0,'{{voornaam}}, hoe vinden jullie nu nieuwe klanten?','Hoi {{voornaam}},\n\nIk zie dat {{bedrijf}} actief is in {{industrie}}. Jullie lijken precies het type bedrijf dat wij helpen.\n\nIk ben Marvin van FirstLeads.nl. Wij genereren B2B afspraken via LinkedIn en email voor MKB-bedrijven. Gemiddeld 8 tot 15 gekwalificeerde gesprekken per maand, volledig op onze eigen content en accounts.\n\nJullie hoeven alleen de gesprekken te voeren.\n\nZou dit interessant zijn voor {{bedrijf}}? Dan plan ik graag een kort gesprek van 15 minuten in.\n\nGroet,\nMarvin Oosterhof\nFirstLeads.nl | 06 40997278','email')`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('email_2','Email 2 - Follow-up dag 3',3,'Re: Hoeveel kost een nieuwe klant jullie?','Hoi {{voornaam}},\n\nStuurde je dinsdag een mail. Eén directe vraag:\n\nWat is een nieuwe klant jullie gemiddeld waard over 12 maanden?\n\nBij de meeste bedrijven die wij spreken is dat €5.000 tot €50.000+. Wij leveren 8 tot 15 gekwalificeerde gesprekken per maand voor €997 per maand. De investering verdient zich terug op de eerste deal.\n\nGeen resultaat in de eerste 30 dagen? Dan werken wij gratis door totdat we die gesprekken leveren.\n\nHeb je 15 minuten deze week?\n\nGroet,\nMarvin\nFirstLeads.nl','email')`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('email_3','Email 3 - Follow-up dag 7',7,'Re: Wat doet {{bedrijf}} anders dan de concurrent?','Hoi {{voornaam}},\n\nIk ben benieuwd: wat maakt {{bedrijf}} anders dan andere bedrijven in {{industrie}}?\n\nIk vraag dit omdat wij die differentiatie gebruiken in onze outreach. Als wij voor jullie prospectie doen, is de boodschap altijd specifiek voor jullie — geen generieke templates.\n\nDat is precies waarom onze klanten gemiddeld 12% reply rate halen op cold email versus de industriestandaard van 2-3%.\n\nKan ik jullie dat laten zien in een gesprek van 15 minuten?\n\nGroet,\nMarvin\nFirstLeads.nl | 06 40997278','email')`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('email_4','Email 4 - Laatste mail',14,'Re: {{bedrijf}}, laatste mail van mij','Hoi {{voornaam}},\n\nDit is mijn laatste mail.\n\nAls de timing niet klopt of het gewoon niet past, geen probleem. Ik snap het.\n\nMocht {{bedrijf}} ooit meer B2B gesprekken willen genereren zonder zelf koud te bellen of eindeloos op LinkedIn te posten, kijk dan op firstleads.nl.\n\nSucces,\nMarvin Oosterhof\nFirstLeads.nl | 06 40997278','email')`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('linkedin_1','LinkedIn connectieverzoek',0,'Connectieverzoek','Hoi {{voornaam}}, ik help {{industrie}} bedrijven aan meer B2B klanten via LinkedIn en email. Lijkt me interessant om te connecten. Groet, Marvin','linkedin')`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('linkedin_2','LinkedIn follow-up 1 (dag 2)',2,'Follow-up na connect','Bedankt voor het connecten, {{voornaam}}! Ik ben benieuwd: hoe genereren jullie nu nieuwe klanten bij {{bedrijf}}? Vooral benieuwd of LinkedIn al een rol speelt in jullie salesproces.','linkedin')`,
      `INSERT OR IGNORE INTO outreach_sequences (name,label,delay_days,subject,body,channel) VALUES ('linkedin_3','LinkedIn follow-up 2 (dag 5)',5,'Pitch','Hoi {{voornaam}}, nog even over {{bedrijf}}. Wij helpen vergelijkbare bedrijven in {{industrie}} aan 8-15 extra gesprekken per maand via LinkedIn. Volledig op onze accounts en ons budget. Heb je 15 minuten voor een korte call?','linkedin')`,
    ];
    for (const stmt of stmts) {
      await env.DB.prepare(stmt).run();
    }
    return json({ ok: true, message: 'Database migrated & seeded' });
  }

  return json({ error: 'Not found' }, 404);
}
