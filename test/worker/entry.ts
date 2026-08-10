import { FeedbackAllowance } from "../../src/durable-objects/FeedbackAllowance";
export { FeedbackAllowance };

export default {
  fetch() {
    return new Response("test worker");
  }
};
