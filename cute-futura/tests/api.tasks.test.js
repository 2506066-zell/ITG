import handler from '../api/tasks.js';
import { mockQuery } from './setup.js';

describe('Tasks API', () => {
    let req, res;

    beforeEach(() => {
        req = { method: 'GET', headers: {}, body: {} };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
    });

    test('GET /tasks returns list', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Test' }] });

        await handler(req, res);

        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM tasks'));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith([{ id: 1, title: 'Test' }]);
    });

    test('POST /tasks creates task with defaults', async () => {
        req.method = 'POST';
        req.body = { title: 'New Task' };
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, title: 'New Task', priority: 'medium' }] });

        await handler(req, res);

        expect(mockQuery).toHaveBeenCalled();
        const args = mockQuery.mock.calls[0];
        expect(args[0]).toContain('INSERT INTO tasks');
        expect(args[1]).toEqual(['New Task', 'TestUser', null, 'medium', 'TestUser', null]); // Check defaults
        expect(res.status).toHaveBeenCalledWith(200);
    });

    test('PUT /tasks completes task and awards score', async () => {
        req.method = 'PUT';
        req.body = { id: 1, completed: true };

        // Mock existing task check
        mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ id: 1, created_by: 'TestUser', completed: false, priority: 'medium' }]
            })
            .mockResolvedValueOnce({ rows: [{ id: 1, completed: true }] }); // Update result

        await handler(req, res);

        // Verify score logic: Base(10) * Medium(1.5) = 15
        const updateCall = mockQuery.mock.calls[1];
        expect(updateCall[0]).toContain('score_awarded=$6'); // Check index of score param
        expect(updateCall[1]).toContain(15);

        expect(res.status).toHaveBeenCalledWith(200);
    });

    test('DELETE /tasks respects ownership', async () => {
        req.method = 'DELETE';
        req.url = 'http://x/?id=1';

        // Mock task owned by someone else
        mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ id: 1, created_by: 'OtherUser' }]
        });

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Permission denied' });
    });
});
