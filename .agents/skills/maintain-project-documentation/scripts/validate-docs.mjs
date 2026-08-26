#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = resolveRoot(process.argv.slice(2))
const docsDir = path.join(root, 'docs')
const referencesDir = path.join(docsDir, 'references')
const evidenceDir = path.join(docsDir, 'evidence')
const indexPath = path.join(docsDir, 'README.md')
const errors = []
const warnings = []

if (!fs.existsSync(docsDir)) {
    fail(`Documentation directory does not exist: ${docsDir}`)
}

const docs = listFiles(docsDir, file => file.endsWith('.md')).sort()
const referenceDocs = docs.filter(documentPath => isWithin(documentPath, referencesDir))
const coreDocs = docs.filter(
    documentPath =>
        !isWithin(documentPath, referencesDir) && !isWithin(documentPath, evidenceDir),
)
const memoryDocs = [...coreDocs, ...referenceDocs].sort()
const evidenceFiles = listFiles(evidenceDir, () => true).sort()
if (!fs.existsSync(indexPath)) {
    errors.push(`Missing documentation index: ${relative(indexPath)}`)
}

const indexedTargets = fs.existsSync(indexPath)
    ? collectRelativeLinkTargets(indexPath, fs.readFileSync(indexPath, 'utf8'))
    : new Set()

const linkedTargets = new Set()
for (const documentPath of memoryDocs) {
    const text = fs.readFileSync(documentPath, 'utf8')
    validateRelativeLinks(documentPath, text)
    for (const target of collectRelativeLinkTargets(documentPath, text)) linkedTargets.add(target)

    if (documentPath !== indexPath && !indexedTargets.has(path.resolve(documentPath))) {
        errors.push(`${relative(documentPath)} is not linked from ${relative(indexPath)}`)
    }
}

for (const evidencePath of evidenceFiles) {
    if (!linkedTargets.has(path.resolve(evidencePath))) {
        errors.push(`${relative(evidencePath)} is not linked from a core or reference document`)
    }
}

validateReferenceIndex(referenceDocs)
validateReferences(referenceDocs)

const totalWords = coreDocs.reduce((sum, documentPath) => {
    const text = fs.readFileSync(documentPath, 'utf8').trim()
    return sum + (text ? text.split(/\s+/u).length : 0)
}, 0)

if (totalWords > 6000) {
    errors.push(`Core documentation exceeds 6,000 words: ${totalWords}`)
} else if (totalWords >= 5500) {
    warnings.push(`Core documentation is approaching its 6,000-word limit: ${totalWords}`)
}

for (const warning of warnings) {
    console.warn(`WARNING: ${warning}`)
}

if (errors.length > 0) {
    for (const error of errors) {
        console.error(`ERROR: ${error}`)
    }
    process.exit(1)
}

console.log(
    `Validated core documents: ${coreDocs.length} (${totalWords} words); references: ${referenceDocs.length}; evidence files: ${evidenceFiles.length}.`,
)
console.log('Index coverage, internal links, core limits, reference contracts, and evidence ownership are valid.')

function resolveRoot(args) {
    if (args.length === 0) return process.cwd()
    if (args.length === 2 && args[0] === '--root') return path.resolve(args[1])
    fail('Usage: validate-docs.mjs [--root path]')
}

function validateRelativeLinks(documentPath, text) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const rawTarget = match[1].trim()
        const target = rawTarget.split('#')[0]
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue

        let decoded
        try {
            decoded = decodeURIComponent(target)
        } catch {
            errors.push(`${relative(documentPath)} contains an invalid encoded link: ${rawTarget}`)
            continue
        }

        const resolved = path.resolve(path.dirname(documentPath), decoded)
        if (!isWithin(resolved, docsDir)) continue
        if (!fs.existsSync(resolved)) {
            errors.push(`${relative(documentPath)} contains a broken link: ${rawTarget}`)
        }
    }
}

function collectRelativeLinkTargets(documentPath, text) {
    const targets = new Set()
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim().split('#')[0]
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
        try {
            targets.add(path.resolve(path.dirname(documentPath), decodeURIComponent(target)))
        } catch {
            // Link validation reports the malformed target.
        }
    }
    return targets
}

function validateReferences(referenceDocs) {
    for (const referencePath of referenceDocs) {
        if (path.dirname(referencePath) !== referencesDir) {
            errors.push(`${relative(referencePath)} must be one level below ${relative(referencesDir)}/`)
        }

        const text = fs.readFileSync(referencePath, 'utf8')
        if (!/^> Non-authoritative reference\.\s*$/mu.test(text)) {
            errors.push(`${relative(referencePath)} is missing the non-authoritative warning`)
        }

        const ownerMatch = text.match(/^> Core owner: \[[^\]]+\]\(([^)]+)\)\s*$/mu)
        if (!ownerMatch) {
            errors.push(`${relative(referencePath)} is missing a linked core owner`)
        } else {
            const ownerPath = resolveRelativeTarget(referencePath, ownerMatch[1])
            if (!ownerPath || !coreDocs.includes(ownerPath)) {
                errors.push(`${relative(referencePath)} has an invalid core owner: ${ownerMatch[1]}`)
            }
        }

        const verifyTargets = collectQuotedList(text, 'Verify against')
        if (verifyTargets.length === 0) {
            errors.push(`${relative(referencePath)} must declare at least one authoritative source`)
        }
        for (const value of verifyTargets) {
            const target = unwrapTarget(value)
            if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
            if (!target) errors.push(`${relative(referencePath)} has an empty verification source`)
        }

        if (collectQuotedList(text, 'Review when').length === 0) {
            errors.push(`${relative(referencePath)} must declare at least one review condition`)
        }

        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
            const targetPath = resolveRelativeTarget(referencePath, match[1])
            if (targetPath && targetPath !== referencePath && isWithin(targetPath, referencesDir)) {
                errors.push(`${relative(referencePath)} must not depend on another reference: ${match[1]}`)
            }
        }
    }
}

function validateReferenceIndex(referenceDocs) {
    if (referenceDocs.length === 0 || !fs.existsSync(indexPath)) return

    const indexText = fs.readFileSync(indexPath, 'utf8')
    const heading = '## Specialized references'
    const start = indexText.indexOf(heading)
    if (start === -1) {
        errors.push('docs/README.md must contain a Specialized references section')
        return
    }

    const remainder = indexText.slice(start + heading.length)
    const nextHeading = remainder.search(/^## /mu)
    const section = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)
    const targets = collectRelativeLinkTargets(indexPath, section)
    for (const referencePath of referenceDocs) {
        if (!targets.has(referencePath)) {
            errors.push(
                `${relative(referencePath)} is not listed under Specialized references in docs/README.md`,
            )
        }
    }
}

function collectQuotedList(text, heading) {
    const lines = text.split(/\r?\n/u)
    const start = lines.findIndex(line => line.trim() === `> ${heading}:`)
    if (start === -1) return []

    const values = []
    for (const line of lines.slice(start + 1)) {
        const match = line.match(/^> - (.+)$/u)
        if (!match) break
        values.push(match[1].trim())
    }
    return values
}

function unwrapTarget(value) {
    if ((value.startsWith('`') && value.endsWith('`')) || (value.startsWith('<') && value.endsWith('>'))) {
        return value.slice(1, -1)
    }
    return value
}

function resolveRelativeTarget(documentPath, rawTarget) {
    const target = rawTarget.trim().split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return null
    try {
        return path.resolve(path.dirname(documentPath), decodeURIComponent(target))
    } catch {
        return null
    }
}

function listFiles(directoryPath, includeFile) {
    const output = []
    if (!fs.existsSync(directoryPath)) return output

    for (const entry of fs.readdirSync(directoryPath, {withFileTypes: true})) {
        const fullPath = path.join(directoryPath, entry.name)
        if (entry.isDirectory()) {
            output.push(...listFiles(fullPath, includeFile))
        } else if (entry.isFile() && includeFile(fullPath)) {
            output.push(fullPath)
        }
    }
    return output
}

function isWithin(filePath, directoryPath) {
    const relation = path.relative(directoryPath, filePath)
    return relation === '' || (!relation.startsWith('..' + path.sep) && relation !== '..' && !path.isAbsolute(relation))
}

function relative(filePath) {
    return path.relative(root, filePath) || '.'
}

function fail(message) {
    console.error(message)
    process.exit(1)
}
