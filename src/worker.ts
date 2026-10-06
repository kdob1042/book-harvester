import app from './index.ts';
import {withAIOperations} from './ai-operation-worker.ts';
export {BookService} from './book-service.ts';
export default withAIOperations(app);
