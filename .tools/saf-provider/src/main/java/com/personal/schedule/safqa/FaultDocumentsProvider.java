package com.personal.schedule.safqa;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.FileNotFoundException;

/** A real SAF boundary that deliberately rejects opening the newly picked URI.
 * Never installed on the human's phone or bundled in the product APK.
 * https://developer.android.com/reference/android/provider/DocumentsProvider
 */
public final class FaultDocumentsProvider extends DocumentsProvider {
    private static final String[] DOCUMENTS = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS, Document.COLUMN_SIZE
    };
    @Override public boolean onCreate() { return true; }
    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : new String[] {
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE,
            Root.COLUMN_FLAGS, Root.COLUMN_AVAILABLE_BYTES
        });
        cursor.newRow().add(Root.COLUMN_ROOT_ID,"moment-faults")
            .add(Root.COLUMN_DOCUMENT_ID,"root").add(Root.COLUMN_TITLE,"MOMENT SAF QA")
            .add(Root.COLUMN_FLAGS,Root.FLAG_SUPPORTS_CREATE|Root.FLAG_LOCAL_ONLY)
            .add(Root.COLUMN_AVAILABLE_BYTES,1024L*1024L);
        return cursor;
    }
    private void add(MatrixCursor cursor, String id) {
        boolean directory = id.equals("root") || id.equals("denied") || id.equals("full");
        String name = id.equals("root") ? "MOMENT SAF QA" : id.equals("denied") ? "Permission denied" : id.equals("full") ? "No space" : id.substring(id.indexOf(':')+1);
        cursor.newRow().add(Document.COLUMN_DOCUMENT_ID,id).add(Document.COLUMN_DISPLAY_NAME,name)
            .add(Document.COLUMN_MIME_TYPE,directory?Document.MIME_TYPE_DIR:"application/json")
            .add(Document.COLUMN_FLAGS,directory?Document.FLAG_DIR_SUPPORTS_CREATE:Document.FLAG_SUPPORTS_WRITE)
            .add(Document.COLUMN_SIZE,0);
    }
    @Override public Cursor queryDocument(String id, String[] projection) {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DOCUMENTS);
        add(cursor,id); return cursor;
    }
    @Override public Cursor queryChildDocuments(String parent, String[] projection, String order) {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DOCUMENTS);
        if(parent.equals("root")){ add(cursor,"denied"); add(cursor,"full"); }
        return cursor;
    }
    @Override public String createDocument(String parent, String mimeType, String name) throws FileNotFoundException {
        if(!parent.equals("denied") && !parent.equals("full")) throw new FileNotFoundException("Select a fault folder");
        return parent+":"+name;
    }
    @Override public boolean isChildDocument(String parent, String child) {
        return parent.equals("root") || child.startsWith(parent+":");
    }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
        if(id.startsWith("denied:")) throw new SecurityException("QA provider revoked permission (EACCES)");
        throw new FileNotFoundException("QA provider has no space left on device (ENOSPC)");
    }
}
