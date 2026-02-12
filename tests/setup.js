export const mockQuery = jest.fn();
export const mockPool = {
    query: mockQuery,
    on: jest.fn(),
};

jest.mock('../api/_lib.js', () => ({
    pool: mockPool,
    verifyToken: jest.fn(() => ({ user: 'TestUser' })),
    readBody: jest.fn((req) => req.body),
    logActivity: jest.fn(),
}));

beforeEach(() => {
    mockQuery.mockClear();
});
