// oracledb 는 타입을 함께 주지 않는다. 여기서 쓰는 것만 적는다.
declare module 'oracledb' {
  export interface ResultSet { getRows(n: number): Promise<unknown[]>; close(): Promise<void> }
  export interface Result { metaData?: { name: string }[]; rows?: unknown[]; resultSet?: ResultSet }
  export interface Connection {
    callTimeout: number;
    execute(sql: string, binds?: unknown[], options?: Record<string, unknown>): Promise<Result>;
    rollback(): Promise<void>;
    break(): Promise<void>;
    close(): Promise<void>;
  }
  const oracledb: {
    getConnection(o: { user: string; password: string; connectString: string; connectTimeout?: number; transportConnectTimeout?: number }): Promise<Connection>;
    OUT_FORMAT_ARRAY: number;
    DB_TYPE_NUMBER: unknown;
    DB_TYPE_DATE: unknown;
    DB_TYPE_TIMESTAMP: unknown;
    STRING: unknown;
    thin: boolean;
  };
  export default oracledb;
}
