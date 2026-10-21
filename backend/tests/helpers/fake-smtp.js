// In-memory stand-in for nodemailer's root export: records sent mail, and
// fails when `failNext` is set.
export const smtp = {
	sent: [],
	failNext: null,
	reset() {
		this.sent = [];
		this.failNext = null;
	},
};

export const fakeNodemailer = {
	createTransport(options) {
		return {
			async sendMail(mail) {
				if (smtp.failNext) {
					const err = new Error(smtp.failNext);
					smtp.failNext = null;
					throw err;
				}
				smtp.sent.push({ options, mail });
				return { messageId: mail.messageId };
			},
		};
	},
};
