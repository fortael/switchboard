const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLaunchUrl, parseLaunchArgv, isLaunchUrl } = require('../parse-launch-url');

test('a bare URL opens a new session', () => {
  assert.deepEqual(
    parseLaunchUrl('wootonpad:///home/delirus/work/wootonpad'),
    { projectPath: '/home/delirus/work/wootonpad', continueSession: false }
  );
});

test('the + marker asks for the most recent session instead', () => {
  assert.deepEqual(
    parseLaunchUrl('wootonpad://+/home/delirus/work/wootonpad'),
    { projectPath: '/home/delirus/work/wootonpad', continueSession: true }
  );
});

test('a percent-encoded path is decoded', () => {
  assert.deepEqual(
    parseLaunchUrl('wootonpad://+/home/delirus/my%20work'),
    { projectPath: '/home/delirus/my work', continueSession: true }
  );
});

test('a lone percent is a path, not a crash', () => {
  assert.deepEqual(
    parseLaunchUrl('wootonpad:///home/100%'),
    { projectPath: '/home/100%', continueSession: false }
  );
});

test('a trailing separator is dropped so the path compares equal to a stored one', () => {
  assert.equal(parseLaunchUrl('wootonpad:///home/u/p/').projectPath, '/home/u/p');
  assert.equal(parseLaunchUrl('wootonpad:///home/u/p///').projectPath, '/home/u/p');
  assert.equal(parseLaunchUrl('wootonpad:///').projectPath, '/');
});

test('a Windows-shaped path is normalised on its own separator', () => {
  assert.equal(parseLaunchUrl('wootonpad://C:\\Users\\me\\proj\\').projectPath, 'C:\\Users\\me\\proj');
  assert.equal(
    parseLaunchUrl('wootonpad://\\\\wsl.localhost\\Ubuntu\\home\\u\\p\\').projectPath,
    '\\\\wsl.localhost\\Ubuntu\\home\\u\\p'
  );
});

test('a drive root is a path, not a path plus a separator', () => {
  assert.equal(parseLaunchUrl('wootonpad://C:\\').projectPath, 'C:\\');
});

test('a URL dispatcher that lowercases the scheme is still understood', () => {
  assert.equal(parseLaunchUrl('WOOTONPAD:///home/u/p').projectPath, '/home/u/p');
  assert.equal(isLaunchUrl('WootonPad://+/home/u/p'), true);
});

test('a URL with no path at all is nothing to open', () => {
  assert.equal(parseLaunchUrl('wootonpad://'), null);
  assert.equal(parseLaunchUrl('wootonpad://+'), null);
});

test('another scheme is not ours', () => {
  assert.equal(parseLaunchUrl('claude://code/new?folder=%2Fhome%2Fu'), null);
  assert.equal(parseLaunchUrl(undefined), null);
});

test('--project is read from argv as before', () => {
  assert.deepEqual(
    parseLaunchArgv(['/opt/WootonPad/wootonpad', '--project', '/home/u/p']),
    { projectPath: '/home/u/p', continueSession: false }
  );
});

test('a URL among the arguments is read the same as one delivered by open-url', () => {
  assert.deepEqual(
    parseLaunchArgv(['C:\\Program Files\\WootonPad\\WootonPad.exe', 'wootonpad://+/home/u/p']),
    { projectPath: '/home/u/p', continueSession: true }
  );
});

test('the explicit flag wins over a URL passed alongside it', () => {
  assert.deepEqual(
    parseLaunchArgv(['app', 'wootonpad://+/home/u/other', '--project', '/home/u/p']),
    { projectPath: '/home/u/p', continueSession: false }
  );
});

test('--project gets the same trailing-separator normalisation as a URL', () => {
  assert.equal(parseLaunchArgv(['app', '--project', '/home/u/p/']).projectPath, '/home/u/p');
  assert.equal(parseLaunchArgv(['app', '--project', 'C:\\work\\p\\']).projectPath, 'C:\\work\\p');
});

test('--project is not percent-decoded: a shell argument carries no escapes', () => {
  assert.equal(parseLaunchArgv(['app', '--project', '/home/u/100%20']).projectPath, '/home/u/100%20');
});

test('an ordinary launch asks for no project', () => {
  assert.equal(parseLaunchArgv(['/opt/WootonPad/wootonpad']), null);
  assert.equal(parseLaunchArgv(['electron', '.', '--inspect']), null);
  assert.equal(parseLaunchArgv(['app', '--project']), null);
  assert.equal(parseLaunchArgv(null), null);
});
