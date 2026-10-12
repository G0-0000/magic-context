import { registerPiGuardedContext } from "../../../../packages/pi-plugin/src/pi-context-refusal";
import { __setPiHarnessKindForTesting } from "../../../../packages/pi-plugin/src/pi-harness-kind";

// Minimal managed context: every user message gains a MANAGED667 marker, so a
// captured provider body proves which pass produced it. In `slow` mode the
// first pass outlives OMP's 30 s context-handler timeout.
export default function guard(
	pi: Parameters<typeof registerPiGuardedContext>[0],
) {
	__setPiHarnessKindForTesting("omp");
	let passes = 0;
	registerPiGuardedContext(pi, async (event, _ctx, budget) => {
		const pass = ++passes;
		if (process.env.MC667_MODE === "slow" && pass === 1) {
			await new Promise((resolve) => setTimeout(resolve, 32_000));
			// A real pass checks its guard before publishing anything.
			budget.assertOutcome();
		}
		return {
			messages: event.messages.map((message) =>
				message.role === "user"
					? {
							...message,
							content: Array.isArray(message.content)
								? message.content.map((block) =>
										block.type === "text"
											? { ...block, text: `MANAGED667 ${block.text}` }
											: block,
									)
								: `MANAGED667 ${message.content}`,
						}
					: message,
			),
		};
	});
}
