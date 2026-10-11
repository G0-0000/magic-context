import { registerPiGuardedContext } from "../../../../packages/pi-plugin/src/pi-context-refusal";
import { __setPiHarnessKindForTesting } from "../../../../packages/pi-plugin/src/pi-harness-kind";

export default function guard(
	pi: Parameters<typeof registerPiGuardedContext>[0],
) {
	__setPiHarnessKindForTesting("omp");
	registerPiGuardedContext(pi, async (event) =>
		process.env.MC663_MODE === "no-result"
			? undefined
			: {
					messages: event.messages.map((message) =>
						message.role === "user"
							? {
									...message,
									content: Array.isArray(message.content)
										? message.content.map((block) =>
												block.type === "text"
													? { ...block, text: `MANAGED663 ${block.text}` }
													: block,
											)
										: `MANAGED663 ${message.content}`,
								}
							: message,
					),
				},
	);
}
