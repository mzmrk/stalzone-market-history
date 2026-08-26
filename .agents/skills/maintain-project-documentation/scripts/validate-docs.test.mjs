import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const validator = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-docs.mjs')

test('treats a missing docs directory as empty project memory', () => {
    withProject(project => {
        const result = validate(project)

        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /core documents: 0 .* references: 0; evidence files: 0/u)

        fs.mkdirSync(path.join(project, 'docs'))
        const incompleteMemory = validate(project)

        assert.equal(incompleteMemory.status, 1)
        assert.match(incompleteMemory.stderr, /Missing documentation index: docs\/README\.md/u)
    })
})

test('runs from any installation path and ignores files outside docs', () => {
    withProject(project => {
        write(project, 'README.md', '# Human README\n')
        write(project, 'CONTRIBUTING.md', '# Contributing\n')
        write(project, 'packages/example/AGENTS.md', '# Package instructions\n')
        write(project, 'docs/README.md', '# Project memory\n\n[External source](../missing-source.js)\n')

        const result = validate(project, {useRootArgument: false})

        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /core documents: 1 .* references: 0; evidence files: 0/u)

        write(project, 'docs/README.md', '# Project memory\n\n[Missing document](missing.md)\n')

        const brokenInternalLink = validate(project, {useRootArgument: false})

        assert.equal(brokenInternalLink.status, 1)
        assert.match(brokenInternalLink.stderr, /broken link: missing\.md/u)
    })
})

test('allows 6,000 core words and rejects any excess', () => {
    withProject(project => {
        write(project, 'docs/README.md', `${'word '.repeat(6000)}\n`)

        const boundary = validate(project)

        assert.equal(boundary.status, 0, boundary.stderr)

        write(project, 'docs/README.md', `${'word '.repeat(6001)}\n`)

        const excess = validate(project)

        assert.equal(excess.status, 1)
        assert.match(excess.stderr, /Core documentation exceeds 6,000 words/u)
    })
})

test('validates reference structure without inspecting declared source files', () => {
    withProject(project => {
        write(
            project,
            'docs/README.md',
            [
                '# Project memory',
                '',
                '[Owner](owner.md)',
                '',
                '## Specialized references',
                '',
                '- [Specialized detail](references/detail.md)',
                '',
            ].join('\n'),
        )
        write(project, 'docs/owner.md', '# Owner\n')
        write(
            project,
            'docs/references/detail.md',
            [
                '> Non-authoritative reference.',
                '> Core owner: [Owner](../owner.md)',
                '> Verify against:',
                '> - `src/source.js`',
                '> Review when:',
                '> - Source behavior changes',
                '',
                '# Detail',
                '',
                'The original response is preserved as [raw evidence](../evidence/raw-response.md).',
                '',
            ].join('\n'),
        )
        write(project, 'docs/evidence/raw-response.md', '# Unprocessed response\n')

        const result = validate(project)

        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /core documents: 2 .* references: 1; evidence files: 1/u)

        assert.doesNotMatch(result.stderr, /src\/source\.js/u)
    })
})

test('allows linked evidence and rejects orphaned evidence', () => {
    withProject(project => {
        write(project, 'docs/README.md', '# Project memory\n\n[Market behavior](market.md)\n')
        write(
            project,
            'docs/market.md',
            [
                '# Market behavior',
                '',
                'The original display is preserved in the [market capture](evidence/market/offer.png).',
                '',
            ].join('\n'),
        )
        write(project, 'docs/evidence/market/offer.png', 'raw image bytes')

        const linked = validate(project)

        assert.equal(linked.status, 0, linked.stderr)
        assert.match(linked.stdout, /evidence files: 1/u)

        write(project, 'docs/evidence/market/orphan.json', '{}\n')

        const orphaned = validate(project)

        assert.equal(orphaned.status, 1)
        assert.match(orphaned.stderr, /orphan\.json is not linked from a core or reference document/u)
    })
})

function validate(project, {useRootArgument = true} = {}) {
    const args = useRootArgument ? [validator, '--root', project] : [validator]
    return spawnSync(process.execPath, args, {cwd: project, encoding: 'utf8'})
}

function withProject(callback) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'maintain-docs-test-'))
    try {
        write(project, 'AGENTS.md', '# Instructions\n')
        callback(project)
    } finally {
        fs.rmSync(project, {recursive: true, force: true})
    }
}

function write(project, relativePath, contents) {
    const target = path.join(project, relativePath)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, contents)
}
