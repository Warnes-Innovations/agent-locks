"""Apply ONE semantically-valid control deletion to store.ts, for a deletion proof.

Every mutation must leave valid TypeScript. Removing a control by breaking the syntax
measures the compiler, not the test suite -- an earlier attempt did exactly that and
reported a broken build as evidence of wiring.
"""
import sys

PATH = 'src/lock/store.ts'

# A pass-through with withRecordLock's signature, so removing the LOCK does not remove
# the call structure around it.
SHIM = (
    'const NO_LOCK = async <T>(_p: string, fn: () => Promise<T>): Promise<T> => fn();\n\n'
)

MUTATIONS = {
    'update-lock': ('return withRecordLock(found.filePath,', 'return NO_LOCK(found.filePath,'),
    'finish-lock': ('return withRecordLock(activeFilePath,', 'return NO_LOCK(activeFilePath,'),
    'heartbeat-lock': ('return withRecordLock(filePath,', 'return NO_LOCK(filePath,'),
    'reap-lock': ('await withRecordLock(candidate.filePath,', 'await NO_LOCK(candidate.filePath,'),
    'reopen-lock': ('return withRecordLock(doneFilePath,', 'return NO_LOCK(doneFilePath,'),
    # `void previousUpdated;` keeps the now-unused variable legal, so the proof removes
    # the CONTROL rather than tripping tsc's unused-variable check.
    'touch-update': ("await recordTouch(locksRoot, record, previousUpdated, 'update', params.agent_id);", 'void previousUpdated;'),
    'touch-finish': ("await recordTouch(locksRoot, record, previousUpdated, 'finish', params.agent_id);", 'void previousUpdated;'),
    'touch-heartbeat': ("await recordTouch(locksRoot, record, previousUpdated, 'heartbeat', params.agent_id);", 'void previousUpdated;'),
    'reap-dest-guard': ("    await assertDestinationFree(newFilePath, record.frontmatter.id, 'reap');\n", ''),
}

name = sys.argv[1]
if name not in MUTATIONS:
    sys.exit(f'unknown mutation {name}')

src = open(PATH).read()
old, new = MUTATIONS[name]
if old not in src:
    sys.exit(f'anchor not found for {name}')
src = src.replace(old, new, 1)

# Only insert the shim when the mutation actually uses it, or tsc rejects it as unused.
if 'NO_LOCK' in new:
    src = src.replace('async function withRecordLock<T>(', SHIM + 'async function withRecordLock<T>(', 1)

open(PATH, 'w').write(src)
