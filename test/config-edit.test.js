import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initConfig,
  getConfig,
  saveConfigText,
  readConfigText,
  configVersion,
  listBackups,
  readBackup,
  ConfigConflictError,
} from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const yaml = (slug) => `tenants:\n  ${slug}:\n    organizer: moi@ex.com\n`;

test('édition de la config : validation, sauvegarde, conflit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-'));
  const file = path.join(dir, 'config', 'config.yaml');
  const template = path.join(dir, 'example.yaml');
  fs.writeFileSync(template, yaml('exemple'));

  // création depuis le modèle si absent
  initConfig({ path: file, backupDir: path.join(dir, 'backups'), template }, quiet);
  fs.unwatchFile(file);
  assert.deepEqual([...getConfig().tenants.keys()], ['exemple']);

  // YAML invalide : rien n'est écrit, config en service inchangée
  const v1 = configVersion(readConfigText());
  assert.throws(() => saveConfigText('tenants: { a: {} }', v1), /organizer/);
  assert.throws(() => saveConfigText('tenants: [oops', v1));
  assert.equal(readConfigText(), yaml('exemple'));
  assert.equal(listBackups().length, 0);

  // enregistrement valide : appliqué + sauvegarde de l'ancienne version
  saveConfigText(yaml('nouvelle'), v1);
  assert.deepEqual([...getConfig().tenants.keys()], ['nouvelle']);
  assert.equal(readConfigText(), yaml('nouvelle'));
  const backups = listBackups();
  assert.equal(backups.length, 1);
  assert.equal(readBackup(backups[0].name), yaml('exemple'));
  assert.throws(() => readBackup('../../etc/passwd'), /invalide/);

  // version périmée : conflit, rien n'est écrit
  assert.throws(() => saveConfigText(yaml('autre'), v1), ConfigConflictError);
  assert.equal(readConfigText(), yaml('nouvelle'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('formulaire : objet -> YAML -> même config, ${VAR} conservés', async () => {
  const { parseRawConfig, dumpConfig, parseConfig } = await import('../src/config.js');
  const doc = {
    tenants: {
      support: {
        title: 'Support',
        password: '${SUPPORT_PWD}',
        organizer: { account: 'moi@ex.com' },
        calendars: ['alice@ex.com', { id: 'salle@group.calendar.google.com', invite: false }],
        weekly_hours: { mon: ['08:30-12:00', '14:00-24:00'], tue: [] },
        date_overrides: { '2026-12-24': [] },
        durations: [15, '1h'],
        event: { description: 'Ligne 1\n\n{{first_name}}' },
      },
    },
    defaults: { min_notice: '2h' },
    site: { title: 'RDV' },
  };
  const text = dumpConfig(doc);
  assert.match(text, /^# Fichier géré/);
  assert.ok(text.indexOf('site:') < text.indexOf('defaults:') && text.indexOf('defaults:') < text.indexOf('tenants:'));
  assert.deepEqual(parseRawConfig(text), doc);
  process.env.SUPPORT_PWD = 'x';
  const t = parseConfig(text).tenants.get('support');
  assert.equal(t.password, 'x');
  assert.deepEqual(t.durations, [15, 60]);
});
