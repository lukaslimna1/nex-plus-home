import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('NEX+ Build Locks · Concurrency & Exclusive Ownership', () => {
  it('1. Aquisição exclusiva com flag wx tem sucesso no primeiro processo', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-lock-test-'));
    const lockFile = path.join(tempDir, '.test.lock');

    // Processo 1 adquire com flag 'wx'
    const fd1 = fs.openSync(lockFile, 'wx');
    const lockData1 = JSON.stringify({ pid: process.pid, timestamp: Date.now(), type: 'test' });
    fs.writeFileSync(fd1, lockData1, 'utf8');
    fs.closeSync(fd1);

    assert.ok(fs.existsSync(lockFile));
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(content.pid, process.pid);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('2. Processo concorrente falha imediatamente com EEXIST e não sobrescreve lock alheio', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-lock-test-'));
    const lockFile = path.join(tempDir, '.test.lock');

    // Processo 1 adquire
    const fd1 = fs.openSync(lockFile, 'wx');
    const lockData1 = JSON.stringify({ pid: 11111, timestamp: Date.now(), type: 'process-1' });
    fs.writeFileSync(fd1, lockData1, 'utf8');
    fs.closeSync(fd1);

    // Processo 2 tenta adquirir o mesmo lock
    let errorThrown: NodeJS.ErrnoException | null = null;
    try {
      fs.openSync(lockFile, 'wx');
    } catch (err) {
      errorThrown = err as NodeJS.ErrnoException;
    }

    // Fail-closed comprovado
    assert.ok(errorThrown !== null);
    assert.equal(errorThrown.code, 'EEXIST');

    // Conteúdo original preservado intacto
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(content.pid, 11111);
    assert.equal(content.type, 'process-1');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('3. Liberação do lock pelo dono permite que um novo processo adquira normalmente', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-lock-test-'));
    const lockFile = path.join(tempDir, '.test.lock');

    // Processo 1 adquire e libera
    const fd1 = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd1, JSON.stringify({ pid: process.pid }), 'utf8');
    fs.closeSync(fd1);
    fs.unlinkSync(lockFile);

    // Processo 3 adquire com sucesso
    const fd3 = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd3, JSON.stringify({ pid: 33333, type: 'process-3' }), 'utf8');
    fs.closeSync(fd3);

    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(content.pid, 33333);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
