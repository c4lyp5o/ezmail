import { vi } from "vitest";

// Controllable EventSource stand-in: FakeEventSource.last.emit({ type }).
export class FakeEventSource {
	static instances = [];
	static get last() {
		return FakeEventSource.instances.at(-1);
	}
	constructor(url) {
		this.url = url;
		this.closed = false;
		FakeEventSource.instances.push(this);
	}
	emit(event) {
		this.onmessage?.({ data: JSON.stringify(event) });
	}
	close() {
		this.closed = true;
	}
}

export function installEventSource() {
	FakeEventSource.instances = [];
	vi.stubGlobal("EventSource", FakeEventSource);
	return FakeEventSource;
}
