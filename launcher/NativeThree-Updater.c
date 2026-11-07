// NativeThree-Updater.exe v0.7: independent Win32 updater for Game.exe + scene.js
// No Chromium, browser, Node, Deno, .NET or Python at runtime.
// Downloads ONLY two fixed filenames from owner's public GitHub Release.
// Install is staged and SHA-256 checked, with backup and rollback.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")

#define MAX_GAME_BYTES (120u*1024u*1024u)
#define MAX_SCENE_BYTES (8u*1024u*1024u)
#define NUM_FILES 2

static const WCHAR* manifestUri=L"/orogdor/NativeThreeBridge/releases/latest/download/update-v2.txt";
static const WCHAR* gameUri=L"/orogdor/NativeThreeBridge/releases/latest/download/NativeThree-Game.exe";
static const WCHAR* sceneUri=L"/orogdor/NativeThreeBridge/releases/latest/download/scene.js";

typedef struct Asset {
    char dest[MAX_PATH], staging[MAX_PATH], backup[MAX_PATH], expected[65];
    const WCHAR *uri;
    unsigned int limit;
    int modified, installed, backed;
} Asset;

static char folder[MAX_PATH], logPath[MAX_PATH], versionPath[MAX_PATH];
static FILE *logFile=NULL;

static void makePath(char out[MAX_PATH], const char *tail) {
    if (sprintf_s(out, MAX_PATH, "%s\\%s", folder,tail)<0) {
        MessageBoxA(NULL,"Path too long","Updater",MB_OK|MB_ICONERROR);
        ExitProcess(12);
    }
}
static int exists(const char *path) {
    DWORD a=GetFileAttributesA(path);
    return a!=INVALID_FILE_ATTRIBUTES && !(a&FILE_ATTRIBUTE_DIRECTORY);
}
static void logline(const char *line) {
    FILE *f=NULL;
    if(!fopen_s(&f,logPath,"ab") && f){
        fprintf(f,"%s\r\n",line);fclose(f);
    }
}
static int validSHA(const char *s) {
    if(strlen(s)!=64)return 0;
    for(unsigned int i=0;i<64;i++){
        if(!((s[i]>='0' && s[i]<='9')||(s[i]>='a' && s[i]<='f')||(s[i]>='A' && s[i]<='F')))return 0;
    }
    return 1;
}
static int validVersion(const char *s) {
    unsigned int a,b,c;char extra;
    return sscanf_s(s,"%u.%u.%u%c",&a,&b,&c,&extra,1)==3;
}
static int sha256File(const char *path,char output[65]) {
    FILE *f=NULL;
    if(fopen_s(&f,path,"rb") || !f)return 0;
    HCRYPTPROV provider=0; HCRYPTHASH hash=0;
    BYTE buf[16384],value[32];DWORD length=32;
    int ok=0;
    if(!CryptAcquireContextA(&provider,NULL,NULL,PROV_RSA_AES,CRYPT_VERIFYCONTEXT))goto done;
    if(!CryptCreateHash(provider,CALG_SHA_256,0,0,&hash))goto done;
    for(;;){
        size_t n=fread(buf,1,sizeof(buf),f);
        if(n>0 && !CryptHashData(hash,buf,(DWORD)n,0))goto done;
        if(n<sizeof(buf)){
            if(ferror(f))goto done;
            break;
        }
    }
    if(!CryptGetHashParam(hash,HP_HASHVAL,value,&length,0) || length!=32)goto done;
    {
        const char *h="0123456789abcdef";
        for(int i=0;i<32;i++){output[i*2]=h[value[i]>>4];output[i*2+1]=h[value[i]&15];}
        output[64]=0;
    }
    ok=1;
done:
    if(hash)CryptDestroyHash(hash);
    if(provider)CryptReleaseContext(provider,0);
    fclose(f);
    return ok;
}
static HINTERNET beginGet(HINTERNET connection,const WCHAR* uri){
    HINTERNET request=WinHttpOpenRequest(connection,L"GET",uri,NULL,NULL,NULL,WINHTTP_FLAG_SECURE);
    if(!request)return NULL;
    DWORD code=0,cb=sizeof(code);
    if(!WinHttpSendRequest(request,NULL,0,NULL,0,0,0) ||
       !WinHttpReceiveResponse(request,NULL) ||
       !WinHttpQueryHeaders(request,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,
                            NULL,&code,&cb,NULL) || code!=200) {
        WinHttpCloseHandle(request);
        return NULL;
    }
    return request;
}
static int getManifest(HINTERNET connection,char version[32],char gameSHA[65],char sceneSHA[65]){
    HINTERNET h=beginGet(connection,manifestUri);
    if(!h)return 0;
    char data[512]={0};DWORD received=0,total=0;int ok=1;
    while(total<sizeof(data)-1){
        if(!WinHttpReadData(h,data+total,(DWORD)(sizeof(data)-1-total),&received)) {ok=0;break;}
        if(!received)break;
        total+=received;
    }
    WinHttpCloseHandle(h);
    if(!ok || total<130)return 0;
    char *context=NULL;
    char *header=strtok_s(data,"\r\n",&context);
    char *v=strtok_s(NULL,"\r\n",&context);
    char *sha1=strtok_s(NULL,"\r\n",&context);
    char *sha2=strtok_s(NULL,"\r\n",&context);
    if(!header || strcmp(header,"NTB2")!=0 || !v || !validVersion(v) ||
       !sha1 || !validSHA(sha1) || !sha2 || !validSHA(sha2) || strlen(v)>30)return 0;
    strcpy_s(version,32,v);
    strcpy_s(gameSHA,65,sha1);
    strcpy_s(sceneSHA,65,sha2);
    return 1;
}
static int downloadFile(HINTERNET connection,Asset *a){
    HINTERNET h=beginGet(connection,a->uri);
    if(!h)return 0;
    FILE *out=NULL;
    if(fopen_s(&out,a->staging,"wb") || !out) {WinHttpCloseHandle(h);return 0;}
    BYTE buf[16384];DWORD got=0;unsigned int total=0;int ok=1;
    for(;;){
        if(!WinHttpReadData(h,buf,sizeof(buf),&got)){ok=0;break;}
        if(got==0)break;
        if(got>a->limit-total || fwrite(buf,1,got,out)!=got){ok=0;break;}
        total+=got;
    }
    fclose(out);
    WinHttpCloseHandle(h);
    char digest[65]={0};
    if(!ok || total<32 || !sha256File(a->staging,digest) || _stricmp(digest,a->expected)!=0){
        DeleteFileA(a->staging);
        logline("Download rejected: network error or SHA-256 mismatch");
        return 0;
    }
    return 1;
}
static int applyAll(Asset assets[NUM_FILES]){
    // All files are downloaded and verified before any installed file changes.
    int success=1;
    for(int i=0;i<NUM_FILES;i++){
        Asset *a=&assets[i];
        if(!a->modified)continue;
        DeleteFileA(a->backup);
        if(exists(a->dest)){
            if(!MoveFileExA(a->dest,a->backup,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)){
                success=0;break;
            }
            a->backed=1;
        }
        if(!MoveFileExA(a->staging,a->dest,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)){
            success=0;break;
        }
        a->installed=1;
    }
    if(!success){
        // Reverse order to avoid leaving an incomplete multi-file update.
        for(int i=NUM_FILES-1;i>=0;i--){
            Asset *a=&assets[i];
            if(a->installed)DeleteFileA(a->dest);
            if(a->backed)MoveFileExA(a->backup,a->dest,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
        }
        logline("Install failed; original files restored if possible");
    } else {
        for(int i=0;i<NUM_FILES;i++)if(assets[i].backed)DeleteFileA(assets[i].backup);
    }
    for(int i=0;i<NUM_FILES;i++)DeleteFileA(assets[i].staging);
    return success;
}
static void recoverBackup(const char *path,const char *backup){
    if(!exists(path) && exists(backup)){
        MoveFileExA(backup,path,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
    }
}
static int runUpdater(const char *args){
    char exe[MAX_PATH]={0};
    DWORD count=GetModuleFileNameA(NULL,exe,MAX_PATH);
    if(!count || count>=MAX_PATH)return 2;
    char *slash=strrchr(exe,'\\');
    if(!slash)return 2;
    *slash=0;
    strcpy_s(folder,sizeof(folder),exe);
    makePath(logPath,"updater.log");
    makePath(versionPath,"installed-version.txt");
    logline("NativeThree-Updater v0.7 checking GitHub Releases");

    Asset files[NUM_FILES]={0};
    makePath(files[0].dest,"NativeThree-Game.exe");
    makePath(files[0].staging,"NativeThree-Game.exe.new");
    makePath(files[0].backup,"NativeThree-Game.exe.backup");
    files[0].uri=gameUri;
    files[0].limit=MAX_GAME_BYTES;

    char gameDir[MAX_PATH];
    makePath(gameDir,"game");
    CreateDirectoryA(gameDir,NULL);
    makePath(files[1].dest,"game\\scene.js");
    makePath(files[1].staging,"game\\scene.js.new");
    makePath(files[1].backup,"game\\scene.js.backup");
    files[1].uri=sceneUri;
    files[1].limit=MAX_SCENE_BYTES;

    for(int i=0;i<NUM_FILES;i++)recoverBackup(files[i].dest,files[i].backup);
    // Offline GitHub Actions validation: updater and game are distinct binaries.
    if(args && strstr(args,"--self-test")!=NULL){
        char digest1[65]={0},digest2[65]={0};
        int ok=sha256File(files[0].dest,digest1) && sha256File(files[1].dest,digest2);
        logline(ok?"Updater standalone offline self-test OK":"Updater offline self-test FAILED");
        return ok?0:31;
    }
    const int noLaunch=(args && strstr(args,"--check-only")!=NULL);
    char offline[MAX_PATH];makePath(offline,"NO-UPDATE.txt");
    char preserve[MAX_PATH];makePath(preserve,"PRESERVE-SCENE.txt");
    int changed=0,networkFailure=0;

    if(!exists(offline)){
        HINTERNET session=WinHttpOpen(L"NativeThreeBridge-Updater/0.7",
             WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,WINHTTP_NO_PROXY_NAME,
             WINHTTP_NO_PROXY_BYPASS,0);
        if(session){
            WinHttpSetTimeouts(session,2500,2500,6000,8000);
            HINTERNET connection=WinHttpConnect(session,L"github.com",INTERNET_DEFAULT_HTTPS_PORT,0);
            if(connection){
                char version[32]={0},gameHash[65]={0},sceneHash[65]={0};
                if(getManifest(connection,version,gameHash,sceneHash)){
                    strcpy_s(files[0].expected,sizeof(files[0].expected),gameHash);
                    strcpy_s(files[1].expected,sizeof(files[1].expected),sceneHash);
                    for(int i=0;i<NUM_FILES;i++){
                        char current[65]={0};
                        int match=sha256File(files[i].dest,current) &&
                                  _stricmp(current,files[i].expected)==0;
                        files[i].modified=!match;
                    }
                    if(exists(preserve) && exists(files[1].dest))
                        files[1].modified=0; // explicit local-development override

                    int prepared=1;
                    for(int i=0;i<NUM_FILES;i++)if(files[i].modified &&
                        !downloadFile(connection,&files[i])){prepared=0;break;}
                    if(prepared){
                        if(applyAll(files)){
                            changed=files[0].modified||files[1].modified;
                            FILE *f=NULL;
                            if(!fopen_s(&f,versionPath,"wb") && f){
                                fputs(version,f);fclose(f);
                            }
                            logline(changed?"Updated changed files successfully":"All files current");
                        } else networkFailure=1;
                    } else {
                        for(int i=0;i<NUM_FILES;i++)DeleteFileA(files[i].staging);
                        networkFailure=1;
                    }
                }else{logline("No valid update-v2.txt; offline fallback");networkFailure=1;}
                WinHttpCloseHandle(connection);
            }else{logline("Cannot connect to GitHub");networkFailure=1;}
            WinHttpCloseHandle(session);
        }else{logline("Cannot open WinHTTP session");networkFailure=1;}
    }else logline("NO-UPDATE.txt present - update disabled");

    if(noLaunch){
        MessageBoxA(NULL,
          changed?"The game EXE / script update installed successfully.":
          networkFailure?"Update check unavailable; local files preserved.":
          "Local game files are already current.",
          "NativeThree Updater",MB_OK | (networkFailure?MB_ICONWARNING:MB_ICONINFORMATION));
        return networkFailure?1:0;
    }
    if(!exists(files[0].dest)){
        MessageBoxA(NULL,"NativeThree-Game.exe is missing. Extract the full release ZIP.",
                    "NativeThree Updater",MB_OK|MB_ICONERROR);
        return 3;
    }
    if((INT_PTR)ShellExecuteA(NULL,"open",files[0].dest,NULL,folder,SW_SHOWNORMAL)<=32){
        MessageBoxA(NULL,"The game EXE could not be started. Check updater.log.",
                    "NativeThree Updater",MB_OK|MB_ICONERROR);
        return 4;
    }
    return 0;
}
int WINAPI WinMain(HINSTANCE a,HINSTANCE b,LPSTR args,int show){
    (void)a;(void)b;(void)show;
    return runUpdater(args);
}
