const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const https = require('https');
const http = require('http');
const ip = require('ip');
const net = require('net');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Zu viele Anfragen von dieser IP. Bitte später erneut versuchen.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.set('trust proxy', false);

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: 'ultrageheimes_sitzungsgeheimnis_!123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 1000 * 60 * 60 * 2,
    sameSite: 'strict',
  }
}));

app.disable('x-powered-by');

const CERT_DIR = '/etc/letsencrypt/live/velink.me';
const KEY_PATH = path.join(CERT_DIR, 'privkey.pem');
const CERT_PATH = path.join(CERT_DIR, 'fullchain.pem');

function certificatesExist() {
  try {
    return fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);
  } catch {
    return false;
  }
}

if (certificatesExist()) {
  console.log('Zertifikate gefunden, starte HTTPS-Server...');
  const options = {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };

  https.createServer(options, app).listen(443, '0.0.0.0', () => {
    console.log('HTTPS-Server läuft auf Port 443');
  });
} else {
  console.log('Keine Zertifikate gefunden, starte HTTP-Server auf Port 8000...');
  http.createServer(app).listen(8000, '0.0.0.0', () => {
    console.log('HTTP-Server läuft auf Port 8000');
  });
}

const whitelist = ["88.45.1.255"];
const isWhitelistActive = false;

function isWhitelisted(ipAddress) {
  if (!ip.isV4Format(ipAddress) && !ip.isV6Format(ipAddress)) {
    return false;
  }

  for (const entry of whitelist) {
    if (entry.includes('/')) {
      if (ip.cidrSubnet(entry).contains(ipAddress)) {
        return true;
      }
    } else {
      if (ipAddress === entry) {
        return true;
      }
    }
  }
  return false;
}

function ipWhitelist(req, res, next) {
  if (!isWhitelistActive) {
    return next();
  }

  let clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim();

  if (!clientIp || !net.isIP(clientIp)) {
    clientIp = req.ip;
  }

  if (isWhitelisted(clientIp)) {
    return next();
  } else {
    const err = new Error('Access denied: This IP address is not allowed.');
    err.status = 403;
    console.warn(`Blocked IP: ${clientIp}`);
    return next(err);
  }
}

module.exports = ipWhitelist;

const db = new sqlite3.Database('./users.db', (err) => {
  if (err) console.error('DB-Fehler:', err.message);
  else console.log('📦 SQLite3-Nutzerdatenbank verbunden');
});

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
)`);

const profileDB = new sqlite3.Database('./profiles.db', (err) => {
  if (err) console.error('Profil-DB-Fehler:', err.message);
  else console.log('📦 SQLite3-Profil-Datenbank verbunden');
});

profileDB.run(`CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  bio TEXT,
  avatar TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

profileDB.run(`ALTER TABLE profiles ADD COLUMN visits TEXT DEFAULT ''`, (err) => {
  if (err && !err.message.includes("duplicate column")) {
    console.error('Fehler beim Hinzufügen der visits-Spalte:', err.message);
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(limiter);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN_RESPONSE_TIME = 500;

function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('start', { user: req.session.user, username, from });
});

app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');

  db.all("SELECT username FROM users", (err, rows) => {
    if (err) {
      return res.status(500).send('Fehler beim Erstellen der Sitemap');
    }

    const urls = rows.map(user => `
      <url>
        <loc>https://velink.me/profile/${user.username}</loc>
        <changefreq>weekly</changefreq>
        <priority>0.7</priority>
      </url>
    `).join('');

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://velink.me/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://velink.me/register</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://velink.me/login</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  ${urls}
</urlset>`;

    res.send(sitemap);
  });
});

app.get('/register', ipWhitelist, (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', ipWhitelist, async (req, res) => {
  const { username, email, password } = req.body;
  const start = Date.now();

  if (!username || !email || !password)
    return res.render('register', { error: 'Alle Felder ausfüllen.' });

  try {
    db.get("SELECT id FROM users WHERE username = ? OR email = ?", [username, email], async (err, user) => {
      if (err) return res.render('register', { error: 'Interner Fehler.' });

      if (user) {
        const elapsed = Date.now() - start;
        if (elapsed < MIN_RESPONSE_TIME) await delay(MIN_RESPONSE_TIME - elapsed);

        return res.render('register', { error: 'Registrierung nicht möglich.' });
      }

      const hashed = await bcrypt.hash(password, 12);
      db.run("INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
        [username, email, hashed],
        function (err) {
          if (err) return res.render('register', { error: 'Registrierung nicht möglich.' });

          const userId = this.lastID;
          profileDB.run("INSERT INTO profiles (user_id, bio, avatar) VALUES (?, ?, ?)",
            [userId, '', 'default.png'], (err) => {
              if (err) console.error('Profil konnte nicht angelegt werden:', err.message);
            });

          req.session.user = { id: userId, username, email };
          res.redirect(`/?from=register`);
        });
    });
  } catch (e) {
    res.render('register', { error: 'Interner Fehler. Bitte später versuchen.' });
  }
});

app.get('/login', ipWhitelist, (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', ipWhitelist, async (req, res) => {
  const { username, password } = req.body;
  const start = Date.now();

  if (!username || !password) {
    return res.render('login', { error: 'Alle Felder ausfüllen.' });
  }

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    let valid = false;

    if (user && !err) {
      try {
        valid = await bcrypt.compare(password, user.password);
      } catch (_) {
        valid = false;
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed < MIN_RESPONSE_TIME) {
      await delay(MIN_RESPONSE_TIME - elapsed);
    }

    if (!user || !valid) {
      return res.render('login', { error: 'Ungültige Anmeldedaten.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email
    };
    res.redirect(`/?from=login`);
  });
});

app.get('/logout', ipWhitelist, (req, res) => {
  if (!req.session) {
    return res.redirect('/');
  }

  req.session.destroy(err => {
    if (err) {
      console.error('Fehler beim Logout:', err.message);
      return res.redirect('/?error=session');
    }

    res.clearCookie('connect.sid', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    res.redirect('/?from=logout');
  });
});

app.get('/profile/:username', async (req, res) => {
  const start = Date.now();
  const requestedUsername = req.params.username;
  const loggedInUser = req.session?.user;
  const isOwnProfile = loggedInUser && loggedInUser.username === requestedUsername;

  let user = null;
  let profile = {
    bio: '',
    avatar: '/img/default.png'
  };

  try {
    user = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM users WHERE username = ?", [requestedUsername], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (user) {
      const profileData = await new Promise((resolve, reject) => {
        profileDB.get("SELECT * FROM profiles WHERE user_id = ?", [user.id], (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });

      if (profileData) {
        profile.bio = profileData.bio || '';
        profile.avatar = profileData.avatar || '/img/default.png';
      }
    }
  } catch (error) {
    console.error('Fehler beim Laden des Profils:', error);
  }

  const elapsed = Date.now() - start;
  if (elapsed < MIN_RESPONSE_TIME) {
    await delay(MIN_RESPONSE_TIME - elapsed);
  }

  // URL für OpenGraph etc.
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  if (!user) {
    return res.status(404).render('profile', {
      username: requestedUsername,
      email: '',
      isOwnProfile: false,
      profile: {
        bio: 'Profil nicht gefunden.',
        avatar: '/img/default.png'
      },
      user: loggedInUser,
      url: fullUrl
    });
  }

  res.render('profile', {
    username: user.username,
    email: user.email,
    isOwnProfile,
    profile,
    user: loggedInUser,
    url: fullUrl
  });
});



app.get('/manage', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/manage', { user, username, from });
});

app.get('/feed', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/feed', { user, username, from });
});

app.get('/settings', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/settings', { user, username, from });
});

app.get('/customize', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/customize', { user, username, from });
});

app.get('/connections', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/connections', { user, username, from });
});

app.get('/custom-domain', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/custom-domain', { user, username, from });
});

app.get('/analytics', isAuthenticated, (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('acc/analytics', { user, username, from });
});

app.get('/datenschutz', (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('datenschutz', { user, username, from });
})

app.get('/nutzungsbedingungen', (req, res) => {
  const user = req.session.user;
  const username = req.session.user ? req.session.user.username : null;
  const from = req.query.from;
  res.render('nutzungsbedingungen', { user, username, from });
});

app.use((req, res, next) => {
  const err = new Error('Die angeforderte Seite wurde nicht gefunden.');
  err.status = 404;
  next(err);
});

app.use((err, req, res, next) => {
  const errorCode = err.status || 500;
  const errorMessage = err.message || 'Ein unerwarteter Fehler ist aufgetreten.';

  console.error(err.stack);

  res.status(errorCode).render('error', {
    errorCode,
    errorMessage
  });
});
