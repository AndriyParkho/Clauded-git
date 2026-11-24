import type { ReactElement } from 'react';
import { api } from '../api';
import { ChatView } from './chat/ChatView';
import { ImplementView } from './implement/ImplementView';
import { GitMenu } from './MergeIntegration';
import { PrView } from './pulls/PrView';
import { SpecView } from './spec/SpecView';
import type { Run } from '../../../shared/protocol';

/** La vue d'un onglet selon son type (chat, implémentation, review de PR, spec). */
export function RunContent({ run }: { run: Run }): ReactElement {
    if (run.type === 'implement' || run.type === 'merge') return <ImplementView run={run} />;
    if (run.type === 'spec') return <SpecView run={run} />;
    if (run.type === 'pr') return <PrView run={run} />;
    if (run.repoId !== null && (run.issueNumber !== null || run.prNumber !== null)) {
        // Chat lié à une issue (ou une PR) : merge de master dans sa branche, et de sa branche dans develop.
        const what = run.issueNumber !== null ? `la branche de l'issue #${run.issueNumber}` : `la branche de la PR #${run.prNumber}`;
        const actions = <GitMenu repoId={run.repoId} base={run.baseBranch} what={what} mergeBase={() => api.mergeBase(run.id)} mergeIntegration={() => api.mergeIntegration(run.id)} runId={run.id} />;
        return <ChatView run={run} actions={actions} />;
    }
    return <ChatView run={run} />;
}
