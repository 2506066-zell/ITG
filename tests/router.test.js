
import router from '../api/router.js';
import { mockQuery } from './setup.js';

describe('Router & Reports Integration', () => {
    let req, res;

    beforeEach(() => {
        res = {
            statusCode: 200,
            setHeader: jest.fn(),
            end: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
    });

    test('Router routes /reports to reports handler', async () => {
        req = {
            url: '/api/reports?type=weekly',
            method: 'GET',
            headers: { host: 'localhost' }
        };

        // Mock the searchParams.get('path') which is what the router uses
        // In Vercel, req.url might be just the path or include query
        // The router does: const u = new URL(req.url, 'http://x');
        // let p = (u.searchParams.get('path') || '').toString().trim();

        req.url = '/api/router?path=reports';

        // Mock database responses for reports.js
        mockQuery.mockResolvedValue({ rows: [{ count: 0 }], rowCount: 0 });

        await router(req, res);

        // If it wasn't found, statusCode would be 404
        expect(res.statusCode).not.toBe(404);
        // It might be 500 if DB fails, but 404 is what we fixed
    });

    test('Router still returns 404 for unknown routes', async () => {
        req = {
            url: '/api/router?path=nonexistent',
            method: 'GET',
            headers: { host: 'localhost' }
        };

        await router(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Not Found'));
    });
});
